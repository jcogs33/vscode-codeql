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
import {
  pathExists,
  ensureDir,
  ensureDir as fse_ensureDir,
  readdir,
  move,
  remove,
} from "fs-extra";
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
import type { Octokit } from "@octokit/rest";
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

      // Get path to the query used by the variant analysis.
      const queryFilePath = variantAnalysis.query.filePath;
      if (!(await pathExists(queryFilePath))) {
        throw new Error(`Query file used by variant analysis not found.`);
      }
      // const queryFileBasename = basename(queryFilePath);
      const queryFilePathNoExt = join(
        dirname(queryFilePath),
        parse(queryFilePath).name,
      );

      // Get the path to the query help, which may be either a `.qhelp` or a `.md` file.
      // Note: we assume that the name of the query file is the same as the name of the query help file.
      const queryHelpFilePathQhelp = `${queryFilePathNoExt}.qhelp`;
      const queryHelpFilePathMarkdown = `${queryFilePathNoExt}.md`;
      let queryHelpFilePath: string;
      // Set `queryHelpFilePath` to the existing extension type.
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
        throw new Error(
          `Query metadata for ${queryFilePath} is missing an ID.`,
        );
      }
      // Replace `/` with `-` for use with the overridden query help's filename.
      // Use `replaceAll` since some query IDs have multiple slashes.
      const queryIdWithDash = queryId.replaceAll("/", "-");

      // Get the path to the local autofix installation.
      // TODO: document the need for this environment variable.
      // TODO: maybe configure differently instead (config file, user setting, etc.)
      progress(progressUpdate(1, 4, `checking for local autofix installation`));
      const localAutofixPath = process.env.AUTOFIX_PATH;
      if (!localAutofixPath) {
        throw new Error(
          "Environment variable AUTOFIX_PATH is not set. Please set it to the path of the local autofix installation.",
        );
      }
      // Check if the local autofix path exists.
      if (!(await pathExists(localAutofixPath))) {
        throw new Error(
          `Local autofix path ${localAutofixPath} does not exist. Please check that the path stored in environment variable AUTOFIX_PATH is correct.`,
        );
      }

      // Get the path to the output directory for overriding the query help.
      const queryHelpOverrideDirectory = `${localAutofixPath}/prompt-templates/qhelps/${queryIdWithDash}.md`;

      // Generate the query help and output it to the override directory.
      progress(
        progressUpdate(
          2,
          4,
          `generating query help override at ${queryHelpOverrideDirectory}`,
        ),
      );
      await cliServer.generateQueryHelp(
        queryHelpFilePath,
        queryHelpOverrideDirectory,
      );

      // ! Below 13-ish lines are mostly copied from `copyRepoListToClipboard`.
      // ! Refactor and share code?
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
        return;
      }

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
      // Create directory path for storing the source roots.
      const sourceRootsStoragePath = `${variantAnalysisStoragePath}/autofix/source-roots`;
      // Create directory path for all autofix results.
      let autofixOutputStoragePath = `${variantAnalysisStoragePath}/autofix/output`;
      // if the path already exists, assume that it's a previous run and append "-n" to the end of the path
      // where n is the next available number.
      if (await pathExists(autofixOutputStoragePath)) {
        let i = 1;
        while (await pathExists(autofixOutputStoragePath + i.toString())) {
          i++;
        }
        autofixOutputStoragePath = autofixOutputStoragePath += i.toString();
      }

      // Initialize an array to store the source root paths.
      const sourceRootPaths: string[] = [];
      // Initialize an array to store the sarif paths.
      const sarifPaths: string[] = [];
      // Initialize an array to store the output files.
      const outputTextFiles: string[] = [];

      const octokit = await credentials.getOctokit();

      progress(
        progressUpdate(3, 4, `processing ${fullNames.length} repositories`),
      );
      await Promise.all(
        fullNames.map(async (nwo) =>
          withProgress(
            async (progressInner: ProgressCallback) => {
              // Read the contents of the variant analysis' `repo_task.json` file.
              const repoStoragePath = join(variantAnalysisStoragePath, nwo);
              const repoTask: VariantAnalysisRepositoryTask =
                await readRepoTask(repoStoragePath);
              // Check if the `databaseCommitSha` exists in the file contents.
              // We need this check to allow the `null` type below, else
              // TypeScript wants `undefined`.
              // ! Confirm if should throw an error like this here.
              if (!repoTask.databaseCommitSha) {
                throw new Error(`Missing database commit SHA for ${nwo}`);
              }
              if (!repoTask.resultCount) {
                throw new Error(
                  `Missing variant analysis result count for ${nwo}`,
                );
              }
              // Get the `databaseCommitSha` used by the variant analysis.
              // We need this SHA to ensure we download the correct database
              // version for use with the variant analysis' SARIF. Otherwise,
              // we will download the latest database version, which may not
              // be compatible with the SARIF.
              const actualCommitOid: string | null = repoTask.databaseCommitSha;
              const repoResultCount = repoTask.resultCount;

              const nwoWithDash = nwo.replace("/", "-");

              // Download the source root for the repo.
              progressInner(progressUpdate(1, 3, `downloading source root`));
              const srcRootPath = await downloadPublicCommitSource(
                nwo,
                actualCommitOid,
                sourceRootsStoragePath,
                octokit,
                logger,
              );
              // Store the source root path in an array to use with autofix.
              sourceRootPaths.push(srcRootPath);

              // TODO: Move this before database downloading. Should error out if can't find sarif file.
              // Get results directory path.
              const repoResultsStoragePath = join(repoStoragePath, "results");
              // Find sarif file.
              progressInner(progressUpdate(2, 3, `getting sarif`));
              const sarifFiles = await glob(
                `${repoResultsStoragePath}/**/*.sarif`,
              );
              if (sarifFiles.length === 1) {
                // Store the sarif path in an array to use with autofix.
                sarifPaths.push(sarifFiles[0]);
              } else {
                throw new Error(
                  `Expected to find exactly one \`*.sarif\` file for ${nwo}, but found ${sarifFiles.length}.`,
                );
              }

              // Create output directories for repo's autofix results.
              const repoAutofixOutputStoragePath = `${autofixOutputStoragePath}/${nwoWithDash}`;
              await ensureDir(repoAutofixOutputStoragePath);
              // TODO: remove the need for these separated extensions when refactor.
              const txtFileExtension = ".txt";
              const mdFileExtension = ".md";
              const sarifFileExtension = ".sarif";
              const outputTextFile = join(
                repoAutofixOutputStoragePath,
                "output",
              );
              const transcriptFile = join(
                repoAutofixOutputStoragePath,
                "transcript",
              );
              const fixDescriptionFile = join(
                repoAutofixOutputStoragePath,
                "fix-description",
              );
              const sarifOutputFile = join(
                repoAutofixOutputStoragePath,
                "output",
              );

              // ***** Run autofix on the selected repo.
              progressInner(progressUpdate(3, 3, `running autofix`));

              // ./bin/cocofix.js --model capi-dev-4o --dev \
              // --sarif <sarifFiles[0]> \
              // --source-root <srcRootPath> \
              // --format=text --output <output.txt> --diff-style diff \ // ! or do text instead of diff if want line of "=" between fixes
              // --transcript <output-dir>/transcript.md \
              // --fix-description <output-dir>/fix-description.md \
              // --sarif-output <output-dir>/output.sarif

              const cocofixBin = `${localAutofixPath}/bin/cocofix.js`; // TODO: unhardcode later; maybe require config like DCA?

              // Limit number of fixes generated.
              const limitFixesBoolean: boolean =
                repoResultCount > MAX_NUM_FIXES;
              if (limitFixesBoolean) {
                void Window.showInformationMessage(
                  `Only generating autofixes for the first ${MAX_NUM_FIXES} alerts for ${nwo}.`,
                );
                // Call autofix in a loop, for the first MAX_NUM_FIXES alerts

                // TODO: need to append to output file instead of overwriting. Or make three output files...
                // ! I don't like this approach, but I don't want to edit the input sarif.
                // ! DCA seems to re-write the input sarif for its round-robin (confirm).
                const tempOutputTextFiles: string[] = [];
                const fixDescriptionFiles: string[] = [];
                const transcriptFiles: string[] = [];
                const sarifOutputFiles: string[] = [];
                for (let i = 0; i < MAX_NUM_FIXES; i++) {
                  // TODO: rewrite all of this file merging logic. De-dup, etc.
                  tempOutputTextFiles.push(
                    `${outputTextFile}-${i.toString()}${txtFileExtension}`,
                  );
                  fixDescriptionFiles.push(
                    `${fixDescriptionFile}-${i.toString()}${mdFileExtension}`,
                  );
                  transcriptFiles.push(
                    `${transcriptFile}-${i.toString()}${mdFileExtension}`,
                  );
                  sarifOutputFiles.push(
                    `${sarifOutputFile}-${i.toString()}${sarifFileExtension}`,
                  );
                  // TODO: re-write this?
                  // ! Copying DCA for quick PoC. See https://github.com/github/codeql-dca/blob/5a924ef3362dd1d37cd6cc0591554c4a96921754/packages/cli/src/commands/autofix/run-cocofix-on-results.ts#L61
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
                      `${outputTextFile}-${i.toString()}${txtFileExtension}`,
                      "--diff-style",
                      "diff",
                      "--fix-description",
                      `${fixDescriptionFile}-${i.toString()}${mdFileExtension}`,
                      "--transcript",
                      `${transcriptFile}-${i.toString()}${mdFileExtension}`,
                      "--sarif-output",
                      `${sarifOutputFile}-${i.toString()}${sarifFileExtension}`,
                      "--only-alert-number",
                      i.toString(),
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
                // merge the output files together
                // ! Caveat that autofix will call each alert "alert 0", so will look a bit odd in the merged output file.
                await mergeFiles(
                  tempOutputTextFiles,
                  outputTextFile + txtFileExtension,
                  "",
                  "",
                  true,
                );
                await mergeFiles(
                  fixDescriptionFiles,
                  fixDescriptionFile + mdFileExtension,
                  "",
                  "",
                  true,
                );
                await mergeFiles(
                  transcriptFiles,
                  transcriptFile + mdFileExtension,
                  "",
                  "",
                  true,
                );
                await mergeFiles(
                  sarifOutputFiles,
                  sarifOutputFile + sarifFileExtension,
                  "",
                  "",
                  true,
                ); // ! probably won't end up with valid sarif?

                // then delete the individual output files
              } else {
                // Call autofix once for all alerts.
                // ! Refactor so not mostly repeating above.
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
                    outputTextFile + txtFileExtension,
                    "--diff-style",
                    "diff",
                    "--fix-description",
                    fixDescriptionFile + mdFileExtension,
                    "--transcript",
                    transcriptFile + mdFileExtension,
                    "--sarif-output",
                    sarifOutputFile + sarifFileExtension,
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
              // Save output text files for later merging into a single markdown file.
              outputTextFiles.push(outputTextFile + txtFileExtension);
            },
            {
              title: `Processing ${nwo}`,
              cancellable: false,
            },
          ),
        ),
      ); // ! end of Promise.all

      // Output results from ALL repos to a combined markdown file.
      // ! single file case with `mergeFiles` seems fine
      progress(progressUpdate(4, 4, `finalizing autofix results`));
      const combinedOutputTextFile = join(
        autofixOutputStoragePath,
        "autofix-output.md",
      );
      await mergeFiles(
        outputTextFiles,
        combinedOutputTextFile,
        "<details><summary>Fix suggestion details</summary>\n\n```diff\n",
        "```\n\n</details>\n\n ### Notes\n - placeholder\n\n",
        false,
      );

      // Open the combined markdown file.
      await tryOpenExternalFile(app.commands, combinedOutputTextFile);
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

// ! adapted from DCA:
// ! https://github.com/github/codeql-dca/blob/e53cf41d52df20662291ecd99b39d018b2cdf917/packages/utils/src/githubAPI.ts#L2213
export async function downloadPublicCommitSource(
  nwo: string,
  sha: string,
  outputPath: string,
  octokit: Octokit,
  logger: NotificationLogger,
): Promise<string> {
  const [owner, repo] = nwo.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repository name: ${nwo}`);
  }

  // Create output directory if it doesn't exist
  await fse_ensureDir(outputPath);

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
    await fse_ensureDir(dirname(checkoutDir));

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
