import type { RepositoriesFilterSortStateWithIds } from "./shared/variant-analysis-filter-sort";
import {
  defaultFilterSortState,
  filterAndSortRepositoriesWithResults,
} from "./shared/variant-analysis-filter-sort";
import { readRepoTask } from "./repo-tasks-store";
import type {
  VariantAnalysis,
  VariantAnalysisRepositoryTask,
} from "./shared/variant-analysis";
import { window as Window } from "vscode";
import { pathExists, ensureDir, readdir, move, remove } from "fs-extra";
import { join, basename, dirname, parse, join as path_join } from "path";
import type { Credentials } from "../common/authentication";
import { withProgress, progressUpdate } from "../common/vscode/progress";
import type { App } from "../common/app";
import type { CodeQLCliServer } from "../codeql-cli/cli";
import type { NotificationLogger } from "../common/logging";
import type { ProgressCallback } from "../common/vscode/progress";
import { glob } from "glob";
import { tryGetQueryMetadata } from "../codeql-cli/query-metadata";
import type { execFileSync } from "child_process";
import { spawn } from "child_process";
import { readFile, writeFile, unlink, mkdtemp } from "fs/promises";
import { tryOpenExternalFile } from "../common/vscode/external-files";
import { tmpdir } from "os";

// Limit to three repos when generating autofixes so not sending
// too many requests to autofix. Since we only need to validate
// a handle of autofixes for each query, this should be sufficient.
// Consider increasing this in the future if needed.
const MAX_NUM_REPOS: number = 3;
// Similarly, limit to three fixes per repo.
const MAX_NUM_FIXES: number = 3;

// ! Main TODOs:

// ! For myself:
// ! - Refactor most of `viewAutofixesForVariantAnalysisResults` into helper functions.
// ! - Re-organize code order. Fail early if missing anything that is required to run autofix.

// ! For PR, if go that direction:
// ! - Canary with error for non-internal users.
// ! - More error handling.
// ! - Testing.
// ! - Clean up progress handling.

// ! See other notes and comments below for more TODOs.

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
  cliServer: CodeQLCliServer,
): Promise<void> {
  await withProgress(
    async (progress: ProgressCallback) => {
      // Get the variant analysis with the given id.
      const variantAnalysis = variantAnalyses.get(variantAnalysisId);
      if (!variantAnalysis) {
        throw new Error(`No variant analysis with id: ${variantAnalysisId}`);
      }

      // Get the path to the local autofix installation.
      progress(progressUpdate(1, 4, `checking for local autofix installation`));
      const localAutofixPath = findLocalAutofix();

      // Generate the query help and output it to the override directory.
      progress(progressUpdate(2, 4, `generating query help override`));
      await overrideQueryHelp(variantAnalysis, cliServer, localAutofixPath);

      // Get the full names (nwos) of the selected repositories.
      const selectedRepoNames = getSelectedRepositoryNames(
        variantAnalysis,
        filterSort,
      );

      // Get storage paths for the autofix results.
      const {
        variantAnalysisIdStoragePath,
        sourceRootsStoragePath,
        autofixOutputStoragePath,
      } = await getStoragePaths(variantAnalysisId, storagePath);

      // Process the selected repositories:
      // * Get sarif
      // * Download source root
      // * Run autofix
      progress(
        progressUpdate(
          3,
          4,
          `processing ${selectedRepoNames.length} repositories`,
        ),
      );
      // Initialize an array to store the output files for all repositories.
      // TODO: consider returning outputTextFiles from `processSelectedRepositories` instead of passing it as arg.
      const outputTextFiles: string[] = [];
      await processSelectedRepositories(
        selectedRepoNames,
        variantAnalysisIdStoragePath,
        sourceRootsStoragePath,
        autofixOutputStoragePath,
        localAutofixPath,
        credentials,
        logger,
        outputTextFiles,
      );

      // Output results from all repos to a combined markdown file.
      progress(progressUpdate(4, 4, `finalizing autofix results`));
      const combinedOutputMarkdownFile = join(
        autofixOutputStoragePath,
        "autofix-output.md",
      );
      await mergeFiles(
        outputTextFiles,
        combinedOutputMarkdownFile,
        "<details><summary>Fix suggestion details</summary>\n\n```diff\n",
        "```\n\n</details>\n\n ### Notes\n - placeholder\n\n",
        false,
      );

      // Open the combined markdown file.
      await tryOpenExternalFile(app.commands, combinedOutputMarkdownFile);
    },
    {
      title: "Generating Autofixes",
      cancellable: false, // TODO: consider making cancellable.
    },
  );
}

/**
 * Finds the local autofix installation path from the AUTOFIX_PATH environment variable.
 * Throws an error if the path is not set or does not exist.
 * @returns An object containing the local autofix path.
 * @throws Error if the AUTOFIX_PATH environment variable is not set or the path does not exist.
 */
function findLocalAutofix(): string {
  // TODO: consider use PATH env var instead of separate AUTOFIX_PATH var.
  // TODO: maybe configure differently instead (config file, user setting, etc.)
  // TODO: document the need for this environment variable.
  const localAutofixPath = process.env.AUTOFIX_PATH;
  if (!localAutofixPath) {
    throw new Error("Path to local autofix installation not found.");
  }
  if (!pathExists(localAutofixPath)) {
    throw new Error(`Local autofix path ${localAutofixPath} does not exist.`);
  }
  return localAutofixPath;
}

/**
 * Overrides the query help for a given variant analysis.
 * @param variantAnalysis The variant analysis to override the query help for.
 * @param cliServer The CodeQL CLI server to use for generating the query help.
 * @param localAutofixPath The local path to the autofix installation.
 */
async function overrideQueryHelp(
  variantAnalysis: VariantAnalysis,
  cliServer: CodeQLCliServer,
  localAutofixPath: string,
): Promise<void> {
  // Get path to the query used by the variant analysis.
  const queryFilePath = variantAnalysis.query.filePath;
  if (!(await pathExists(queryFilePath))) {
    throw new Error(`Query file used by variant analysis not found.`);
  }
  const queryFilePathNoExt = join(
    dirname(queryFilePath),
    parse(queryFilePath).name,
  );

  // Get the path to the query help, which may be either a `.qhelp` or a `.md` file.
  // Note: we assume that the name of the query file is the same as the name of the query help file.
  const queryHelpFilePathQhelp = `${queryFilePathNoExt}.qhelp`;
  const queryHelpFilePathMarkdown = `${queryFilePathNoExt}.md`;

  // Set `queryHelpFilePath` to the existing extension type.
  let queryHelpFilePath: string;
  if (await pathExists(queryHelpFilePathQhelp)) {
    queryHelpFilePath = queryHelpFilePathQhelp;
  } else if (await pathExists(queryHelpFilePathMarkdown)) {
    queryHelpFilePath = queryHelpFilePathMarkdown;
  } else {
    throw new Error(
      `Could not find query help file at either ${queryHelpFilePathQhelp} or ${queryHelpFilePathMarkdown}. Check that the query help file exists and is named correctly.`,
    );
  }

  // Get the query metadata.
  const metadata = await tryGetQueryMetadata(cliServer, queryFilePath);
  if (!metadata) {
    throw new Error(`Could not get query metadata for ${queryFilePath}.`);
  }
  // Get the query ID (used for the overridden query help's filename).
  const queryId = metadata.id;
  if (!queryId) {
    throw new Error(`Query metadata for ${queryFilePath} is missing an ID.`);
  }
  // Replace `/` with `-` for use with the overridden query help's filename.
  // Use `replaceAll` since some query IDs have multiple slashes.
  const queryIdWithDash = queryId.replaceAll("/", "-");

  // Get the path to the output directory for overriding the query help.
  const queryHelpOverrideDirectory = `${localAutofixPath}/prompt-templates/qhelps/${queryIdWithDash}.md`;

  await cliServer.generateQueryHelp(
    queryHelpFilePath,
    queryHelpOverrideDirectory,
  );
}

/**
 * Gets the full names (owner/repo) of the selected repositories from the given variant analysis.
 * Throws an error if no repositories with results are found.
 * @param variantAnalysis The variant analysis to get the repositories from.
 * @param filterSort The filter and sort state to use for filtering the repositories.
 * @returns An array of full names (owner/repo) of the selected repositories.
 * @throws Error if no repositories with results are found.
 */
function getSelectedRepositoryNames(
  variantAnalysis: VariantAnalysis,
  filterSort: RepositoriesFilterSortStateWithIds,
): string[] {
  // TODO: consider sharing first two parts with `copyRepoListToClipboard`.
  // Get the repositories that were selected by the user.
  const filteredRepositories = filterAndSortRepositoriesWithResults(
    variantAnalysis.scannedRepos,
    filterSort,
  );

  // Get the full names (owner/repo = nwo) of the selected repos.
  let fullNames = filteredRepositories
    ?.filter((a) => a.resultCount && a.resultCount > 0)
    .map((a) => a.repository.fullName);
  if (!fullNames || fullNames.length === 0) {
    throw new Error("No repositories with results found.");
  }

  // Limit to MAX_NUM_REPOS by slicing the array,
  // and inform the user about the limit.
  if (fullNames.length > MAX_NUM_REPOS) {
    fullNames = fullNames.slice(0, MAX_NUM_REPOS);
    void Window.showInformationMessage(
      `Only the first ${MAX_NUM_REPOS} repos will be included in the Autofix results.`,
    );
  }

  return fullNames;
}

/**
 * Gets the storage paths needed for the autofix results.
 * @param variantAnalysisId The ID of the variant analysis.
 * @param storagePath The base storage path.
 * @returns The storage paths for the autofix results.
 */
async function getStoragePaths(
  variantAnalysisId: number,
  storagePath: string,
): Promise<{
  variantAnalysisIdStoragePath: string;
  sourceRootsStoragePath: string;
  autofixOutputStoragePath: string;
}> {
  // Confirm storage path for the variant analysis ID exists.
  const variantAnalysisIdStoragePath = join(
    storagePath,
    variantAnalysisId.toString(),
  );
  if (!(await pathExists(variantAnalysisIdStoragePath))) {
    throw new Error(
      `Variant analysis storage path does not exist: ${variantAnalysisIdStoragePath}`,
    );
  }

  // Storage path for all autofix info.
  const autofixStoragePath = join(variantAnalysisIdStoragePath, "autofix");

  // Storage path for the source roots used with autofix.
  const sourceRootsStoragePath = join(autofixStoragePath, "source-roots");
  await ensureDir(sourceRootsStoragePath);

  // Storage path for the autofix output.
  let autofixOutputStoragePath = join(autofixStoragePath, "output");
  // If the path already exists, assume that it's a previous run
  // and append "-n" to the end of the path where n is the next available number.
  if (await pathExists(autofixOutputStoragePath)) {
    let i = 1;
    while (await pathExists(autofixOutputStoragePath + i.toString())) {
      i++;
    }
    autofixOutputStoragePath = autofixOutputStoragePath += i.toString();
  }
  await ensureDir(autofixOutputStoragePath);

  return {
    variantAnalysisIdStoragePath,
    sourceRootsStoragePath,
    autofixOutputStoragePath,
  };
}

/** TODO */
async function processSelectedRepositories(
  selectedRepoNames: string[],
  variantAnalysisIdStoragePath: string,
  sourceRootsStoragePath: string,
  autofixOutputStoragePath: string,
  localAutofixPath: string,
  credentials: Credentials,
  logger: NotificationLogger,
  outputTextFiles: string[],
): Promise<void> {
  await Promise.all(
    selectedRepoNames.map(async (nwo) =>
      withProgress(
        async (progressForRepo: ProgressCallback) => {
          // * Get the sarif file.
          progressForRepo(progressUpdate(1, 3, `getting sarif`));
          const repoStoragePath = join(variantAnalysisIdStoragePath, nwo);
          const sarifFile = await getSarifFile(repoStoragePath, nwo);

          // Read the contents of the variant analysis' `repo_task.json` file,
          // and confirm that the `databaseCommitSha` and `resultCount` exist.
          const repoTask: VariantAnalysisRepositoryTask =
            await readRepoTask(repoStoragePath);
          if (!repoTask.databaseCommitSha) {
            throw new Error(`Missing database commit SHA for ${nwo}`);
          }
          if (!repoTask.resultCount) {
            throw new Error(`Missing variant analysis result count for ${nwo}`);
          }

          // * Download the source root.
          progressForRepo(progressUpdate(2, 3, `downloading source root`));
          const srcRootPath = await downloadPublicCommitSource(
            nwo,
            repoTask.databaseCommitSha,
            sourceRootsStoragePath,
            credentials,
            logger,
          );

          // * Run autofix.
          progressForRepo(progressUpdate(3, 3, `running autofix`));
          await runAutofixForRepository(
            nwo,
            sarifFile,
            srcRootPath,
            localAutofixPath,
            autofixOutputStoragePath,
            repoTask.resultCount,
            logger,
            outputTextFiles,
          );
        },
        {
          title: `Processing ${nwo}`,
          cancellable: false,
        },
      ),
    ),
  ); // ! end of Promise.all
}

/**
 * Gets the path to a SARIF file in a given `repoStoragePath`.
 * @param repoStoragePath The storage path for the repository.
 * @param nwo The full name of the repository (owner/repo).
 * @returns The path to the SARIF file.
 */
async function getSarifFile(
  repoStoragePath: string,
  nwo: string,
): Promise<string> {
  // Get results directory path.
  const repoResultsStoragePath = join(repoStoragePath, "results");
  // Find sarif file.
  const sarifFiles = await glob(`${repoResultsStoragePath}/**/*.sarif`);
  if (sarifFiles.length !== 1) {
    throw new Error(
      `Expected to find exactly one \`*.sarif\` file for ${nwo}, but found ${sarifFiles.length}.`,
    );
  }
  return sarifFiles[0];
}

/**
 * Gets the storage paths for the autofix results for a given repository.
 * @param autofixOutputStoragePath The base storage path for the autofix output.
 * @param nwo The full name of the repository (owner/repo).
 * @returns An object containing the storage paths for the autofix results.
 */
async function getRepoStoragePaths(
  autofixOutputStoragePath: string,
  nwo: string,
) {
  // Create output directories for repo's autofix results.
  const repoAutofixOutputStoragePath = join(
    autofixOutputStoragePath,
    nwo.replaceAll("/", "-"),
  );
  await ensureDir(repoAutofixOutputStoragePath);
  return {
    repoAutofixOutputStoragePath,
    outputTextFilePath: join(repoAutofixOutputStoragePath, "output.txt"),
    transcriptFilePath: join(repoAutofixOutputStoragePath, "transcript.md"),
    fixDescriptionFilePath: join(
      repoAutofixOutputStoragePath,
      "fix-description.md",
    ),
  };
}

/**
 * Creates a new file path by appending the given suffix.
 * @param filePath The original file path.
 * @param suffix The suffix to append to the file name (before the extension).
 * @returns The new file path with the suffix appended.
 */
function appendSuffixToFilePath(filePath: string, suffix: string): string {
  const { dir, name, ext } = parse(filePath);
  return join(dir, `${name}-${suffix}${ext}`);
}

/**
 * Runs autofix for a given repository (nwo).
 * @param nwo The full name of the repository (owner/repo).
 * @param sarifFile The path to the SARIF file.
 * @param srcRootPath The path to the source root directory.
 * @param localAutofixPath The path to the local autofix directory.
 * @param autofixOutputStoragePath The path to the autofix output storage directory.
 * @param resultCount The number of results to process.
 * @param logger The logger to use for notifications.
 * @param outputTextFiles An array to store the output text files for later merging.
 */
async function runAutofixForRepository(
  nwo: string,
  sarifFile: string,
  srcRootPath: string,
  localAutofixPath: string,
  autofixOutputStoragePath: string,
  resultCount: number,
  logger: NotificationLogger,
  outputTextFiles: string[],
): Promise<void> {
  // Get storage paths for the autofix results for this repository.
  const {
    repoAutofixOutputStoragePath,
    outputTextFilePath,
    transcriptFilePath,
    fixDescriptionFilePath,
  } = await getRepoStoragePaths(autofixOutputStoragePath, nwo);

  // TODO: unhardcode later, have full bin path in AUTOFIX_PATH env var; maybe require config instead like DCA? And switch for Go autofix.
  const cocofixBin = join(
    process.cwd(), // ! or __dirname instead?
    localAutofixPath,
    "bin",
    "cocofix.js",
  );

  // Limit number of fixes generated.
  const limitFixesBoolean: boolean = resultCount > MAX_NUM_FIXES;
  if (limitFixesBoolean) {
    void Window.showInformationMessage(
      `Only generating autofixes for the first ${MAX_NUM_FIXES} alerts for ${nwo}.`,
    );

    // Call autofix in a loop, for the first MAX_NUM_FIXES alerts
    // ! I don't like this approach, but I don't want to edit the input sarif.
    // ! DCA seems to re-write the input sarif for its round-robin (confirm).
    const tempOutputTextFiles: string[] = [];
    const fixDescriptionFiles: string[] = [];
    const transcriptFiles: string[] = [];

    for (let i = 0; i < MAX_NUM_FIXES; i++) {
      const tempOutputTextFilePath = appendSuffixToFilePath(
        outputTextFilePath,
        i.toString(),
      );
      const tempFixDescriptionFilePath = appendSuffixToFilePath(
        fixDescriptionFilePath,
        i.toString(),
      );
      const tempTranscriptFilePath = appendSuffixToFilePath(
        transcriptFilePath,
        i.toString(),
      );

      tempOutputTextFiles.push(tempOutputTextFilePath);
      fixDescriptionFiles.push(tempFixDescriptionFilePath);
      transcriptFiles.push(tempTranscriptFilePath);

      // ! Copying DCA for quick PoC. See https://github.com/github/codeql-dca/blob/5a924ef3362dd1d37cd6cc0591554c4a96921754/packages/cli/src/commands/autofix/run-cocofix-on-results.ts#L61
      await execAutofix(
        logger,
        cocofixBin,
        [
          "--sarif",
          sarifFile,
          "--source-root",
          srcRootPath,
          "--model",
          "capi-dev-4o", // ! Note: this requires latest version of cocofix; either expect that or try to find which version user has installed
          "--dev",
          "--format",
          "text",
          "--output",
          tempOutputTextFilePath,
          "--diff-style",
          "diff", // ! or do text instead of diff if want line of "=" between fixes
          "--fix-description",
          tempFixDescriptionFilePath,
          "--transcript",
          tempTranscriptFilePath,
          "--only-alert-number",
          i.toString(),
        ],
        {
          cwd: repoAutofixOutputStoragePath,
          env: {
            CAPI_DEV_KEY: process.env.CAPI_DEV_KEY,
            PATH: process.env.PATH, // ! might not need this.
          },
        },
        true,
      );
    }
    // Merge the output files together.
    // Caveat that autofix will call each alert "alert 0", which will look a bit odd in the merged output file.
    await mergeFiles(tempOutputTextFiles, outputTextFilePath, "", "", true);
    await mergeFiles(fixDescriptionFiles, fixDescriptionFilePath, "", "", true);
    await mergeFiles(transcriptFiles, transcriptFilePath, "", "", true);
  } else {
    // Call autofix once for all alerts.
    // ! Refactor so not mostly repeating above.
    await execAutofix(
      logger,
      cocofixBin,
      [
        "--sarif",
        sarifFile,
        "--source-root",
        srcRootPath,
        "--model",
        "capi-dev-4o", // ! Note: this requires latest version of cocofix; either expect that or try to find which version user has installed
        "--dev",
        "--format",
        "text",
        "--output",
        outputTextFilePath,
        "--diff-style",
        "diff", // ! or do text instead of diff if want line of "=" between fixes
        "--fix-description",
        fixDescriptionFilePath,
        "--transcript",
        transcriptFilePath,
      ],
      {
        cwd: repoAutofixOutputStoragePath,
        env: {
          CAPI_DEV_KEY: process.env.CAPI_DEV_KEY,
          PATH: process.env.PATH, // ! might not need this.
        },
      },
      true,
    );
  }

  // Save output text files for later merging into a single markdown file.
  outputTextFiles.push(outputTextFilePath);
}

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

// TODO: refactor this function and the file-merging logic in general.
async function mergeFiles(
  inputFiles: string[],
  outputFile: string,
  frontSeparator: string = "",
  backSeparator: string = "",
  deleteOriginalFiles: boolean = true,
): Promise<void> {
  try {
    // // Merge the files
    // const contents = await Promise.all(
    //   inputFiles.map((file) => readFile(file, "utf8")),
    // );

    if (inputFiles.length === 0 || !(await pathExists(inputFiles[0]))) {
      return; // Nothing to merge
    } // TODO: debug issue with fix-description.md not being created

    // Merge the files with separators
    const contents = await Promise.all(
      inputFiles.map(async (file) => {
        const content = await readFile(file, "utf8");
        return `${frontSeparator}${content}${backSeparator}`;
      }),
    );

    // Add owner/repo header above each set of contents if the separators are not empty strings
    // ! this is getting too specific; separate/refactor this condition
    if (frontSeparator !== "" && backSeparator !== "") {
      // ! hopefully I can assume that the content order matches the input file order (confirm)
      for (let i = 0; i < contents.length; i++) {
        // extract the owner-repo folder name from the input file path
        const parentDir = dirname(inputFiles[i]);
        const ownerDashRepoName = basename(parentDir);
        contents[i] = `## ${ownerDashRepoName}\n\n${contents[i]}`;
      }
    }

    // Write merged content
    await writeFile(outputFile, contents.join("\n"));

    // Delete original files
    if (deleteOriginalFiles) {
      await Promise.all(inputFiles.map((file) => unlink(file))); // ! should maybe use `remove` here instead of `unlink`
    }
  } catch (error) {
    console.error("Error merging files:", error);
    throw error;
  }
}

// ! Idea adapted from DCA and mostly re-written by Copilot
// ! See https://github.com/github/codeql-dca/blob/e53cf41d52df20662291ecd99b39d018b2cdf917/packages/utils/src/githubAPI.ts#L2213
export async function downloadPublicCommitSource(
  nwo: string,
  sha: string,
  outputPath: string,
  credentials: Credentials,
  logger: NotificationLogger,
): Promise<string> {
  const [owner, repo] = nwo.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repository name: ${nwo}`);
  }

  // Create output directory if it doesn't exist
  await ensureDir(outputPath);

  // Define the final checkout directory
  const checkoutDir = path_join(
    outputPath,
    `${owner}-${repo}-${sha.substring(0, 7)}`,
  );

  // Check if directory already exists to avoid re-downloading
  if (await pathExists(checkoutDir)) {
    void logger.log(
      `Source for ${nwo} at ${sha} already exists at ${checkoutDir}.`,
    );
    return checkoutDir;
  }

  void logger.log(`Fetching source of repository ${nwo} at ${sha}...`);

  try {
    // Create a temporary directory for downloading
    const downloadDir = await mkdtemp(path_join(tmpdir(), "download-source-"));
    const tarballPath = path_join(downloadDir, "source.tar.gz");

    const octokit = await credentials.getOctokit();

    // Get the tarball URL
    const { url } = await octokit.rest.repos.downloadTarballArchive({
      owner,
      repo,
      ref: sha,
    });

    // Download the tarball using spawn for better security than shell commands
    await new Promise<void>((resolve, reject) => {
      const curlArgs = [
        "-H",
        "Accept: application/octet-stream",
        "--user-agent",
        "GitHub-CodeQL-Extension",
        "-L", // Follow redirects
        "-o",
        tarballPath,
        url,
      ];

      const process = spawn("curl", curlArgs, { cwd: downloadDir });

      process.on("error", reject);
      process.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`curl exited with code ${code}`)),
      );
    });

    void logger.log(`Download complete, extracting source...`);

    // Extract the tarball
    await new Promise<void>((resolve, reject) => {
      const process = spawn("tar", ["-xzf", tarballPath], { cwd: downloadDir });

      process.on("error", reject);
      process.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`tar extraction failed with code ${code}`)),
      );
    });

    // Remove the tarball to save space
    await unlink(tarballPath);

    // Find the extracted directory (GitHub tarballs extract to a single directory)
    const extractedFiles = await readdir(downloadDir);
    const sourceDir = extractedFiles.filter((f) => f !== "source.tar.gz")[0];

    if (!sourceDir) {
      throw new Error("Failed to find extracted source directory");
    }

    const extractedSourcePath = path_join(downloadDir, sourceDir);

    // Ensure the destination directory's parent exists
    await ensureDir(dirname(checkoutDir));

    // Move the extracted source to the final location
    await move(extractedSourcePath, checkoutDir);

    // Clean up the temporary directory
    await remove(downloadDir);

    return checkoutDir;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to download ${nwo} at ${sha}: ${errorMessage}`);
  }
}
