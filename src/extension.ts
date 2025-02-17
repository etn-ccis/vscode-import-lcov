import * as vscode from "vscode";
import parseLcov, { SectionSummary } from "@friedemannsommer/lcov-parser";
import { loadDemangle } from "./demangle";
import { subscribe } from "node:diagnostics_channel";

interface Configuration {
  lcovFiles: string[];
}

let coverageProfile: vscode.TestRunProfile | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('import-lcov is now active!');
  // Test controller.
  // -----
  const controller = vscode.tests.createTestController(
    "import-lcov",
    "Import Coverage",
  );
  context.subscriptions.push(controller);

  let currentRefreshCts = new vscode.CancellationTokenSource();
  let configuration: Configuration = { lcovFiles: [] };
  const testRunData = new WeakMap<vscode.FileCoverage, SectionSummary>();

  const collectRunData = async (request: vscode.TestRunRequest, token: vscode.CancellationToken) => {
    const run = controller.createTestRun(request);

    console.log("import-lcov coverage loading... ");

    // Compute items whose coverage should be processed.
    const items = new Set(request.include);

    if (items.size === 0) {
      for (const [, item] of controller.items) {
        items.add(item);
      }
    }

    for (const item of request.exclude ?? []) {
      items.delete(item);
    }

    // Read and update coverage.
    await Promise.all([...items].map(async (item) => {
      const uri = item.uri!;
      const contents = await vscode.workspace.fs.readFile(uri);

      if (token.isCancellationRequested) {
        return;
      }

      const sections = await parseLcov({ from: contents });

      if (token.isCancellationRequested) {
        return;
      }

      for (const section of sections) {
        let path: vscode.Uri | undefined;

        for (
          const workspaceFolder of vscode.workspace.workspaceFolders ?? []
        ) {
          const workspacePath = workspaceFolder.uri.fsPath;

          if (section.path.startsWith(workspacePath)) {
            path = vscode.Uri.joinPath(
              workspaceFolder.uri,
              section.path.substring(workspacePath.length + 1 /* / */),
            );
            break;
          }
        }

        const fileCoverage = new vscode.FileCoverage(
          path ?? vscode.Uri.file(section.path),
          /*statementCoverage=*/ new vscode.TestCoverageCount(
            section.lines.hit,
            section.lines.instrumented,
          ),
          /*branchCoverage=*/ new vscode.TestCoverageCount(
            section.branches.hit,
            section.branches.instrumented,
          ),
          /*declarationCoverage=*/ new vscode.TestCoverageCount(
            section.functions.hit,
            section.functions.instrumented,
          ),
        );

        testRunData.set(fileCoverage, section);
        run.addCoverage(fileCoverage);
      }
    }));

    run.end();
  };

  const createCoverageProfile = () => {
    if (coverageProfile) {
      coverageProfile.dispose();
    }
    console.log("import-lcov coverage init...");
    coverageProfile = controller.createRunProfile(
      "Coverage",
      vscode.TestRunProfileKind.Coverage,
      collectRunData
    );
      
    let demangle:
      | undefined
      | Promise<{ (mangled: string): string }>
      | { (mangled: string): string };
  
    coverageProfile.loadDetailedCoverage = async (_, fileCoverage) => {
      const section = testRunData.get(fileCoverage);
  
      if (section === undefined) {
        return [];
      }
  
      const details: vscode.FileCoverageDetail[] = [];
      const branchesByLine = new Map<
        number,
        Record<string, vscode.BranchCoverage>
      >();
  
      for (const branch of section.branches.details) {
        const branches = branchesByLine.get(branch.line) ?? {};
  
        branches[branch.branch] ??= new vscode.BranchCoverage(
          0,
          new vscode.Position(branch.line - 1, 0),
          branch.branch,
        );
        (branches[branch.branch].executed as number) += branch.hit;
  
        branchesByLine.set(branch.line, branches);
      }
  
      for (const line of section.lines.details) {
        details.push(
          new vscode.StatementCoverage(
            line.hit,
            new vscode.Position(line.line - 1, 0),
            Object.values(branchesByLine.get(line.line) ?? {}),
          ),
        );
      }
  
      for (const fn of section.functions.details) {
        if (fn.name.length === 0) {
          continue;
        }
  
        let name = fn.name;
  
        if (/^_{1,3}Z/.test(name)) {
          if (demangle === undefined) {
            demangle = loadDemangle(context);
            demangle = await demangle;
          } else if (demangle instanceof Promise) {
            demangle = await demangle;
          }
  
          name = demangle(name);
        }
  
        details.push(
          new vscode.DeclarationCoverage(
            name,
            fn.hit,
            new vscode.Position(fn.line - 1, 0),
          ),
        );
      }
  
      return details;
    };    
  };

  const refreshTests = async () => {
    console.log("import-lcov refreshing tests...");
    currentRefreshCts.cancel();
    currentRefreshCts = new vscode.CancellationTokenSource();

    const token = currentRefreshCts.token;

    const lcovFiles = await Promise.all(
      configuration.lcovFiles.map((glob) =>
        vscode.workspace.findFiles(
          glob,
          undefined,
          undefined,
          token,
        )
      ),
    ).then((files) => files.flat().sort());

    const items = lcovFiles.map((lcovFile) => {
      return controller.createTestItem(
        /*id=*/ lcovFile.toString(),
        /*label=*/ vscode.workspace.asRelativePath(lcovFile),
        lcovFile,
      );
    });

    controller.items.replace(items);
    collectRunData({ include: items, exclude: [], profile: undefined }, token);
    createCoverageProfile();
  };

  controller.refreshHandler = refreshTests;

  // Configuration.
  // -----
  const refreshConfiguration = () => {
    console.log('import-lcov Refreshing configuration...');
    let lcovFiles = vscode.workspace.getConfiguration("import-lcov").get<
      string | string[]
    >("lcovFiles") ?? [];

    if (typeof lcovFiles === "string") {
      lcovFiles = [lcovFiles];
    }

    const activeConfig: Configuration = { lcovFiles };

    if (JSON.stringify(activeConfig) === JSON.stringify(configuration)) {
      return;
    }

    configuration = activeConfig;

    for (const lcovFile of lcovFiles) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        lcovFile,
        /*ignoreCreateEvents*/ true,
        /*ignoreChangeEvents*/ false,
        /*ignoreDeleteEvents*/ true
      );
      console.log(`import-lcov Watching: ${lcovFile}`);

      context.subscriptions.push(watcher.onDidChange(() => refreshTests()));
    }

    refreshTests();
  };

  refreshConfiguration();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("import-lcov")) {
        refreshConfiguration();
      }
    })
  );
}

export function deactivate() {
  console.log('import-lcov is now deactivated');
  // Clean up resources, if necessary
  if (coverageProfile) {
    coverageProfile.dispose();
  }
}
