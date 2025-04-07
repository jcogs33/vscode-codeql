import type { RepositoriesFilterSortStateWithIds } from "./shared/variant-analysis-filter-sort";
import {
  defaultFilterSortState,
  filterAndSortRepositoriesWithResults,
} from "./shared/variant-analysis-filter-sort";
import { readRepoTask } from "./repo-tasks-store";
import { DatabaseFetcher } from "../databases/database-fetcher";
import { convertGithubNwoToDatabaseUrl } from "../databases/github-databases/api";
import { addDatabaseSourceToWorkspace } from "../config";
import type {
  VariantAnalysis,
  VariantAnalysisRepositoryTask,
} from "./shared/variant-analysis";
import { window as Window } from "vscode";
import { pathExists } from "fs-extra";
import { join } from "path";
import type { Credentials } from "../common/authentication";
import { withProgress } from "../common/vscode/progress";
import type { App } from "../common/app";
import type { DatabaseManager } from "../databases/local-databases";
import type { CodeQLCliServer } from "../codeql-cli/cli";
import type { NotificationLogger } from "../common/logging";
import type { ProgressCallback } from "../common/vscode/progress";
import { unzipToDirectoryConcurrently } from "../common/unzip-concurrently";
import { glob } from "glob";

// Limit to three repos when generating autofixes so not sending
// too many requests to autofix. Since we only need to validate
// a handle of autofixes for each query, this should be sufficient.
// Consider increasing this in the future if needed.
const MAX_NUM_REPOS: number = 3;

/**
 * TODO: doc
 */
export async function viewAutofixesForVariantAnalysisResults(
  variantAnalysisId: number,
  filterSort: RepositoriesFilterSortStateWithIds = defaultFilterSortState,
  variantAnalyses: Map<number, VariantAnalysis>,
  credentials: Credentials,
  logger: NotificationLogger,
  storagePath: string,
  app: App,
  dbm: DatabaseManager,
  cliServer: CodeQLCliServer,
): Promise<void> {
  await withProgress(
    async (progress: ProgressCallback) => {
      // ! Below 17-ish lines are mostly copied from `copyRepoListToClipboard`.
      // ! Refactor and share code?
      const variantAnalysis = variantAnalyses.get(variantAnalysisId);
      if (!variantAnalysis) {
        throw new Error(`No variant analysis with id: ${variantAnalysisId}`);
      }

      const filteredRepositories = filterAndSortRepositoriesWithResults(
        variantAnalysis.scannedRepos,
        filterSort,
      );

      // Get the full names (owner/repo = nwo) of the selected repos.
      let fullNames = filteredRepositories
        ?.filter((a) => a.resultCount && a.resultCount > 0)
        .map((a) => a.repository.fullName);
      if (!fullNames || fullNames.length === 0) {
        return;
      }
      // Get the language used by the variant analysis.
      const language = variantAnalysis.language;

      // Limit to MAX_NUM_REPOS by slicing the array,
      // and inform the user about the limit.
      if (fullNames.length > MAX_NUM_REPOS) {
        fullNames = fullNames.slice(0, MAX_NUM_REPOS);
        void Window.showInformationMessage(
          `Only the first ${MAX_NUM_REPOS} repos will be included in the Autofix results.`,
        );
      }

      // Create directory path for storing the downloaded databases.
      const databasesStoragePath = `${storagePath}/${variantAnalysisId}/autofix-databases`;
      // Find path to the variant analysis' `repo_task.json` file.
      const variantAnalysisStoragePath = `${storagePath}/${variantAnalysisId}`;

      // ! For now, do not make the downloaded database selected
      // ! in the database panel. Consider changing this in the
      // ! future or not adding to the database panel at all.
      // ! If keep in panel, consider adding a "mrva" {pre/suf}fix
      // ! to the database name to make it clear where it came from
      // ! and where it's stored.
      const makeSelected = false;
      // TODO: confirm that I want to call `addDatabaseSourceToWorkspace`
      // versus always setting to a value.
      const addSourceArchiveFolder = addDatabaseSourceToWorkspace();

      // Initialize an array to store the source root paths.
      const sourceRootPaths: string[] = [];
      // Initialize an array to store the sarif paths.
      const sarifPaths: string[] = [];

      const octokit = await credentials.getOctokit();

      // Download the database for each repo.
      // ! Note: consider changing this to not download databases, but to
      // ! instead directly download source code like DCA's cve-download, see:
      // ! https://github.com/github/codeql-dca/blob/b3a50e3ca553b4d721f2c28b358f53d8d039e528/packages/cli/src/commands/cve-download.ts#L386
      // ! Are there any synchronization issues with looping like this?
      // ! Adjust to do in parallel instead. Not horrible as-is since will
      // ! only download three databases at most for now, but still annoying
      // ! to wait unnecessarily.
      for (const nwo of fullNames) {
        const nwoWithDash = nwo.replace("/", "-");
        // Do not re-download the database if it already exists.
        // Do a simple check based on just the folder name,
        // which should be of the form <owner>-<repo>. Caveat:
        // this check could break if the folder name generation changes.
        const repoDatabaseStoragePath = `${databasesStoragePath}/${nwoWithDash}`;
        if (await pathExists(repoDatabaseStoragePath)) {
          // Inform the user that the database already exists and continue.
          void Window.showInformationMessage(
            `Database for ${nwo} already exists at ${databasesStoragePath}. Not re-downloading.`,
          );
          continue;
        }

        // Read the contents of the variant analysis' `repo_task.json` file.
        const repoStoragePath = join(variantAnalysisStoragePath, nwo);
        const repoTask: VariantAnalysisRepositoryTask =
          await readRepoTask(repoStoragePath);
        // Check if the `databaseCommitSha` exists in the file contents.
        // We need this check to allow the `null` type below, else
        // TypeScript wants `undefined`.
        // ! Confirm if should throw an error like this here.
        if (!repoTask.databaseCommitSha) {
          throw new Error("Missing database commit SHA");
        }
        // Get the `databaseCommitSha` used by the variant analysis.
        // We need this SHA to ensure we download the correct database
        // version for use with the variant analysis' SARIF. Otherwise,
        // we will download the latest database version, which may not
        // be compatible with the SARIF.
        const actualCommitOid: string | null = repoTask.databaseCommitSha;

        // ! Much of the below is copied from `downloadGitHubDatabase`
        // ! in extensions/ql-vscode/src/databases/database-fetcher.ts
        // ! Refactor and share code?
        // Get the database URL for the repo.
        const result = await convertGithubNwoToDatabaseUrl(
          nwo,
          octokit,
          progress,
          language,
        );
        if (!result) {
          return;
        }

        const {
          databaseUrl,
          name,
          owner,
          databaseId,
          databaseCreatedAt,
          commitOid,
        } = result;

        // Do not use `commitOid`. Log a message explaining why.
        void logger.log(
          `Not using commit OID ${commitOid} since it may be newer than
           the actual commit SHA ${actualCommitOid} used by the MRVA run.`,
        );

        const databaseFetcher = new DatabaseFetcher(
          app,
          dbm,
          databasesStoragePath,
          cliServer,
        );

        // Download the database for the repo.
        await databaseFetcher.downloadGitHubDatabaseFromUrl(
          databaseUrl,
          databaseId,
          databaseCreatedAt,
          actualCommitOid,
          owner,
          name,
          octokit,
          progress,
          makeSelected,
          addSourceArchiveFolder,
        );

        // Find the database's `src.zip` archive and unzip it into a 'source-root` directory.
        // ! Need more error handling for src.zip that are very large?
        // ! Should have try/catch here?
        // ! Should not stop overall function execution by throwing an error?
        const unzippedFilesDirectory = `${repoDatabaseStoragePath}/source-root`;
        const zipFiles = await glob(`${repoDatabaseStoragePath}/**/src.zip`);
        if (zipFiles.length === 1) {
          await unzipToDirectoryConcurrently(
            zipFiles[0],
            unzippedFilesDirectory,
          );
        } else {
          throw new Error(
            `Expected to find exactly one \`src.zip\` archive, but found ${zipFiles.length}.`,
          );
        }

        // Get the source root path using `unzippedFilesDirectory` and `sourceLocationPrefix`.
        const sourceLocationPrefix = repoTask.sourceLocationPrefix;
        const srcRootPath = `${unzippedFilesDirectory}${sourceLocationPrefix}`;

        // Store the source root path in an array to use with autofix.
        sourceRootPaths.push(srcRootPath);

        // Get results directory path.
        const repoResultsStoragePath = join(repoStoragePath, "results");
        // Find sarif file.
        const sarifFiles = await glob(`${repoResultsStoragePath}/**/*.sarif`);
        if (sarifFiles.length === 1) {
          // Store the sarif path in an array to use with autofix.
          sarifPaths.push(sarifFiles[0]);
        } else {
          // ! Should not stop overall function execution by throwing an error here?
          throw new Error(
            `Expected to find exactly one \`*.sarif\` file, but found ${sarifFiles.length}.`,
          );
        }
      }
    },
    {
      title: "Generating Autofixes",
      // ! Make cancellable later, but leave as
      // ! non-cancellable for now to avoid issues
      // ! with database downloads, etc.
      cancellable: false,
    },
  );
}

// TODO: generate qhelp override (easy-ish)
// TODO: mkdir or otherwise figure out where to store the output from cocofix (medium-ish; try to re-use where extension stores other output?)
// TODO: pass source-root, sarif, and output-dir for each repo to cocofix (easy once have the info)
// TODO: run cocofix and limit to max of 3 autofixes per repo (medium-ish; easy to limit to first alert using `--only-alert-number`, but how to limit to first 3? (check how DCA is doing round-robin))
// TODO: display cocofix results in a new view (or in terminal if easier?) (medium-ish; reuse basics of MRVA view or of compare performance view?)
