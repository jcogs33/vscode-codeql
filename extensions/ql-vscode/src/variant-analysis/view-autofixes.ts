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
import { pathExists, ensureDir } from "fs-extra";
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
import { tryGetQueryMetadata } from "../codeql-cli/query-metadata";
import type { execFileSync } from "child_process";
import { spawn } from "child_process";

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

      // ***** Check for QHelp & metadata first and throw errors if not found.
      // ***** No point in continuing if don't have the QHelp or query ID.
      // Get path to the query used by the variant analysis.
      const queryPath = variantAnalysis.query.filePath;
      const queryPathNoExt = queryPath.slice(0, -3);
      // Get the path to the query help, which may be either a `.qhelp` or a `.md` file.
      // ! Relies on query and qhelp file names matching.
      const queryHelpPathQhelp = `${queryPathNoExt}.qhelp`;
      const queryHelpPathMarkdown = `${queryPathNoExt}.md`;
      let queryHelpPath: string;

      // Confirm which style of query help file exists.
      if (await pathExists(queryHelpPathQhelp)) {
        queryHelpPath = queryHelpPathQhelp;
      } else if (await pathExists(queryHelpPathMarkdown)) {
        queryHelpPath = queryHelpPathMarkdown;
      } else {
        throw new Error(
          `Could not find query help file at either ${queryHelpPathQhelp} or ${queryHelpPathMarkdown}.`,
        );
      }

      // Read the query metadata if possible.
      const metadata = await tryGetQueryMetadata(cliServer, queryPath);
      if (!metadata) {
        throw new Error(`Could not get query metadata for ${queryPath}.`);
      }
      if (!metadata.id) {
        throw new Error(`Query metadata for ${queryPath} is missing an ID.`);
      }
      // Get the query ID for the overridden query help's filename.
      const queryId = metadata.id;
      // Replace `/` with `-` to get the query ID with a dash.
      // `replaceAll` since some query IDs have multiple slashes.
      const queryIdWithDash = queryId.replaceAll("/", "-");

      // Get the path to the local autofix installation.
      // TODO: unhardcode once figure out how to check for local autofix installation
      // TODO: maybe check how DCA with local autofix handles that.
      const localAutofixPath = `/Users/jcogs33/Documents/codeml-autofix/cocofix`;

      // Get the path to the output directory for overriding the query help.
      const queryHelpOverrideDirectory = `${localAutofixPath}/prompt-templates/qhelps/${queryIdWithDash}.md`;

      // Generate the query help and output to the override directory.
      await cliServer.generateQueryHelp(
        queryHelpPath,
        queryHelpOverrideDirectory,
      );

      // ***** Continue with downloading databases, extracting source root paths, and finding SARIF paths.
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

      // Find path to the variant analysis information.
      const variantAnalysisStoragePath = `${storagePath}/${variantAnalysisId}`;
      // Create directory path for storing the downloaded databases.
      const databasesStoragePath = `${variantAnalysisStoragePath}/autofix/databases`;

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

        // TODO: Move this before database downloading. Should error out if can't find sarif file.
        // Get results directory path.
        const repoResultsStoragePath = join(repoStoragePath, "results");
        // Find sarif file.
        const sarifFiles = await glob(`${repoResultsStoragePath}/**/*.sarif`);
        if (sarifFiles.length === 1) {
          // Store the sarif path in an array to use with autofix.
          sarifPaths.push(sarifFiles[0]);
        } else {
          throw new Error(
            `Expected to find exactly one \`*.sarif\` file, but found ${sarifFiles.length}.`,
          );
        }

        // Create output directory for all autofix results.
        const autofixOutputStoragePath = `${variantAnalysisStoragePath}/autofix/output`;
        // Ensures that the directory exists. If the directory structure does not exist, it is created.
        // await ensureDir(autofixOutputStoragePath); // ! don't need if creating for each below

        // Create output directories for repo's autofix results.
        const repoAutofixOutputStoragePath = `${autofixOutputStoragePath}/${nwoWithDash}`;
        await ensureDir(repoAutofixOutputStoragePath);
        const outputTextFile = join(repoAutofixOutputStoragePath, "output.txt");
        const transcriptFile = join(
          repoAutofixOutputStoragePath,
          "transcript.md",
        );
        const fixDescriptionFile = join(
          repoAutofixOutputStoragePath,
          "fix-description.md",
        );
        const sarifOutputFile = join(
          repoAutofixOutputStoragePath,
          "output.sarif",
        );

        // ***** Run autofix on the selected repo.
        // ./bin/cocofix.js --model capi-dev-4o --dev \
        // --sarif <sarifFiles[0]> \
        // --source-root <srcRootPath> \
        // --format=text --output <output.txt> --diff-style diff \ // ! or do text instead of diff if want line of "=" between fixes
        // --transcript <output-dir>/transcript.md \
        // --fix-description <output-dir>/fix-description.md \
        // --sarif-output <output-dir>/output.sarif
        // TODO: re-write this?
        // ! Copying DCA for quick PoC. See https://github.com/github/codeql-dca/blob/5a924ef3362dd1d37cd6cc0591554c4a96921754/packages/cli/src/commands/autofix/run-cocofix-on-results.ts#L61
        const cocofixBin = `${localAutofixPath}/bin/cocofix.js`; // TODO: unhardcode later; maybe require config like DCA?
        await execAutofix(
          logger,
          cocofixBin,
          [
            "--sarif",
            sarifFiles[0],
            "--source-root",
            srcRootPath,
            "--model",
            "capi-dev-4o", // ! Note: this requires latest version of cocofix; either expect that or try to find which version user has installed
            "--dev",
            "--format",
            "text",
            "--output",
            outputTextFile,
            "--diff-style",
            "diff",
            "--fix-description",
            fixDescriptionFile,
            "--transcript",
            transcriptFile,
            "--sarif-output",
            sarifOutputFile,
          ],
          {
            cwd: repoAutofixOutputStoragePath,
            env: {
              CAPI_DEV_KEY: process.env.CAPI_DEV_KEY,
              //   CAPI_DEV_KEY: getSecret(config["capi-key"]), // ! try without this since already set locally
              //   GH_TOKEN: octoman.getToken(slug2repo(source.info.repository)), // ! try without this since I don't think I've been using when running locally...
              PATH: process.env.PATH, // ! might not need this.
            },
          },
          true, // ! just set to true for now
        );
        // ! don't want to return yet, maybe when refactor
        // return {
        //   outputTextFile,
        //   fixDescriptionFile,
        //   transcriptFile,
        //   sarifOutputFile,
        // };
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

// TODO: rewrite this?
// ! Copied from DCA for quick PoC. See https://github.com/github/codeql-dca/blob/4191e85e526a350c40636ab8ff5c18a29a1fba2d/packages/utils/src/util.ts#L236
function execAutofix(
  logger: NotificationLogger,
  bin: string,
  args: string[],
  options: Parameters<typeof execFileSync>[2],
  showCommand?: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const cwd = options?.cwd || process.cwd();
      if (showCommand) {
        void logger.log(`Spawning '${bin} ${args.join(" ")}' in ${cwd}`);
      }
      if (args.some((a) => a === undefined || a === "")) {
        throw new Error(
          `Invalid empty or undefined arguments: ${args.join(" ")}`,
        );
      }
      const p = spawn(bin, args, { stdio: [0, 1, 2], ...options });
      p.on("error", reject);
      p.on("exit", (code) => (code === 0 ? resolve() : reject(code)));
    } catch (e) {
      reject(e);
    }
  });
}

// TODO: limit to max of 3 autofixes per repo (medium-ish; easy to limit to first alert using `--only-alert-number`, but how to limit to first 3? (check how DCA is doing round-robin --> seems to rewrite the input file :(, I don't want to do that))
// TODO: display cocofix results in a new view (or in terminal if easier? or just in combined markdown file for now?) (medium-ish; reuse basics of MRVA view or of compare performance view?)
