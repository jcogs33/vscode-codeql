import type { DirResult } from "tmp";
import { dirSync, fileSync } from "tmp";
import { dirname, join } from "path";
import {
  mkdirs,
  createFile,
  mkdirsSync,
  createFileSync,
  pathExistsSync,
} from "fs-extra";
import { Uri, window } from "vscode";

import type {
  DatabaseImportQuickPickItems,
  DatabaseQuickPickItem,
  DatabaseSelectionQuickPickItem,
} from "../../../../src/databases/local-databases-ui";

import { DatabaseUI } from "../../../../src/databases/local-databases-ui";
import { testDisposeHandler } from "../../test-dispose-handler";
import { createMockApp } from "../../../__mocks__/appMock";
import { QueryLanguage } from "../../../../src/common/query-language";
import { mockedQuickPickItem, mockedObject } from "../../utils/mocking.helpers";
import type { DatabaseFetcher } from "../../../../src/databases/database-fetcher";
import * as dialog from "../../../../src/common/vscode/dialog";
import { createMockDB } from "../../../factories/databases/databases";

describe("local-databases-ui", () => {
  const storageDir = dirSync({ unsafeCleanup: true }).name;
  const db1 = createDatabase(storageDir, "db1-imported", QueryLanguage.Cpp);
  const db2 = createDatabase(storageDir, "db2-notimported", QueryLanguage.Cpp);
  const db3 = createDatabase(storageDir, "db3-invalidlanguage", "hucairz");

  // these two should be deleted
  const db4 = createDatabase(
    storageDir,
    "db4-notimported-with-db-info",
    QueryLanguage.Cpp,
    ".dbinfo",
  );
  const db5 = createDatabase(
    storageDir,
    "db5-notimported-with-codeql-database.yml",
    QueryLanguage.Cpp,
    "codeql-database.yml",
  );

  const app = createMockApp({});

  describe("fixDbUri", () => {
    const fixDbUri = (DatabaseUI.prototype as any).fixDbUri;
    it("should choose current directory normally", async () => {
      const dir = dirSync({ unsafeCleanup: true }).name;
      const uri = await fixDbUri(Uri.file(dir));
      expect(uri.toString()).toBe(Uri.file(dir).toString());
    });

    it("should choose parent directory when file is selected", async () => {
      const file = fileSync().name;
      const uri = await fixDbUri(Uri.file(file));
      expect(uri.toString()).toBe(Uri.file(dirname(file)).toString());
    });

    it("should choose parent directory when db-* is selected", async () => {
      const dir = dirSync({ unsafeCleanup: true }).name;
      const dbDir = join(dir, "db-javascript");
      await mkdirs(dbDir);

      const uri = await fixDbUri(Uri.file(dbDir));
      expect(uri.toString()).toBe(Uri.file(dir).toString());
    });

    it("should choose parent's parent directory when file selected is in db-*", async () => {
      const dir = dirSync({ unsafeCleanup: true }).name;
      const dbDir = join(dir, "db-javascript");
      const file = join(dbDir, "nested");
      await mkdirs(dbDir);
      await createFile(file);

      const uri = await fixDbUri(Uri.file(file));
      expect(uri.toString()).toBe(Uri.file(dir).toString());
    });

    it("should handle a parent whose name is db-*", async () => {
      // fixes https://github.com/github/vscode-codeql/issues/482
      const dir = dirSync({ unsafeCleanup: true }).name;
      const parentDir = join(dir, "db-hucairz");
      const dbDir = join(parentDir, "db-javascript");
      const file = join(dbDir, "nested");
      mkdirsSync(dbDir);
      createFileSync(file);

      const uri = await fixDbUri(Uri.file(file));
      expect(uri.toString()).toBe(Uri.file(parentDir).toString());
    });
  });

  it("should delete orphaned databases", async () => {
    const databaseUI = new DatabaseUI(
      app,
      {
        databaseItems: [{ databaseUri: Uri.file(db1) }],
        onDidChangeDatabaseItem: () => {
          /**/
        },
        onDidChangeCurrentDatabaseItem: () => {
          /**/
        },
        setCurrentDatabaseItem: () => {},
      } as any,
      mockedObject<DatabaseFetcher>({}),
      {
        onLanguageContextChanged: () => {
          /**/
        },
      } as any,
      {} as any,
      storageDir,
      storageDir,
    );
    await databaseUI.handleRemoveOrphanedDatabases();

    expect(pathExistsSync(db1)).toBe(true);
    expect(pathExistsSync(db2)).toBe(true);
    expect(pathExistsSync(db3)).toBe(true);

    expect(pathExistsSync(db4)).toBe(false);
    expect(pathExistsSync(db5)).toBe(false);

    databaseUI.dispose(testDisposeHandler);
  });

  describe("getDatabaseItem", () => {
    const progress = jest.fn();
    describe("when there is a current database", () => {
      const databaseUI = new DatabaseUI(
        app,
        {
          databaseItems: [{ databaseUri: Uri.file(db1) }],
          onDidChangeDatabaseItem: () => {
            /**/
          },
          onDidChangeCurrentDatabaseItem: () => {
            /**/
          },
          setCurrentDatabaseItem: () => {},
          currentDatabaseItem: { databaseUri: Uri.file(db1) },
        } as any,
        mockedObject<DatabaseFetcher>({}),
        {
          onLanguageContextChanged: () => {
            /**/
          },
        } as any,
        {} as any,
        storageDir,
        storageDir,
      );

      it("should return current database", async () => {
        const databaseItem = await databaseUI.getDatabaseItem(progress);

        expect(databaseItem).toEqual({ databaseUri: Uri.file(db1) });
      });
    });

    describe("when there is no current database", () => {
      const databaseManager = {
        databaseItems: [
          { databaseUri: Uri.file(db1) },
          { databaseUri: Uri.file(db2) },
        ],
        onDidChangeDatabaseItem: () => {
          /**/
        },
        onDidChangeCurrentDatabaseItem: () => {
          /**/
        },
        setCurrentDatabaseItem: () => {},
        currentDatabaseItem: undefined,
      } as any;

      const databaseUI = new DatabaseUI(
        app,
        databaseManager,
        mockedObject<DatabaseFetcher>({}),
        {
          onLanguageContextChanged: () => {
            /**/
          },
        } as any,
        {} as any,
        storageDir,
        storageDir,
      );

      it("should prompt for a database and select existing one", async () => {
        const showQuickPickSpy = jest
          .spyOn(window, "showQuickPick")
          .mockResolvedValueOnce(
            mockedQuickPickItem(
              mockedObject<DatabaseSelectionQuickPickItem>({
                databaseKind: "existing",
              }),
            ),
          )
          .mockResolvedValueOnce(
            mockedQuickPickItem(
              mockedObject<DatabaseQuickPickItem>({
                databaseItem: { databaseUri: Uri.file(db2) },
              }),
            ),
          );

        const setCurrentDatabaseItemSpy = jest.spyOn(
          databaseManager,
          "setCurrentDatabaseItem",
        );

        await databaseUI.getDatabaseItem(progress);

        expect(showQuickPickSpy).toHaveBeenCalledTimes(2);
        expect(setCurrentDatabaseItemSpy).toHaveBeenCalledWith({
          databaseUri: Uri.file(db2),
        });
      });

      it("should prompt for a database and import a new one", async () => {
        const showQuickPickSpy = jest
          .spyOn(window, "showQuickPick")
          .mockResolvedValueOnce(
            mockedQuickPickItem(
              mockedObject<DatabaseSelectionQuickPickItem>({
                databaseKind: "new",
              }),
            ),
          )
          .mockResolvedValueOnce(
            mockedQuickPickItem(
              mockedObject<DatabaseImportQuickPickItems>({
                importType: "github",
              }),
            ),
          );

        const handleChooseDatabaseGithubSpy = jest
          .spyOn(databaseUI as any, "handleChooseDatabaseGithub")
          .mockResolvedValue(undefined);

        await databaseUI.getDatabaseItem(progress);

        expect(showQuickPickSpy).toHaveBeenCalledTimes(2);
        expect(handleChooseDatabaseGithubSpy).toHaveBeenCalledTimes(1);
      });

      it("should skip straight to prompting to import a database if there are no existing databases", async () => {
        databaseManager.databaseItems = [];

        const showQuickPickSpy = jest
          .spyOn(window, "showQuickPick")
          .mockResolvedValueOnce(
            mockedQuickPickItem(
              mockedObject<DatabaseImportQuickPickItems>({
                importType: "github",
              }),
            ),
          );

        const handleChooseDatabaseGithubSpy = jest
          .spyOn(databaseUI as any, "handleChooseDatabaseGithub")
          .mockResolvedValue(undefined);

        await databaseUI.getDatabaseItem(progress);

        expect(showQuickPickSpy).toHaveBeenCalledTimes(1);
        expect(handleChooseDatabaseGithubSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("handleRemoveDatabase", () => {
    let showBinaryChoiceDialogSpy: jest.SpiedFunction<
      typeof dialog.showBinaryChoiceDialog
    >;
    let mockDatabaseManager: any;
    let mockLanguageContext: any;
    let databaseUI: DatabaseUI;
    let dir: DirResult;

    beforeEach(() => {
      // Choose 'Yes' when asked "Are you sure?"
      showBinaryChoiceDialogSpy = jest
        .spyOn(dialog, "showBinaryChoiceDialog")
        .mockResolvedValue(true);

      mockDatabaseManager = {
        removeDatabaseItem: jest.fn(),
        onDidChangeDatabaseItem: jest.fn(),
        onDidChangeCurrentDatabaseItem: jest.fn(),
      };

      mockLanguageContext = {
        onLanguageContextChanged: jest.fn(),
      };

      databaseUI = new DatabaseUI(
        {} as any, // app
        mockDatabaseManager,
        {} as any, // databaseFetcher
        mockLanguageContext,
        {} as any, // queryRunner
        storageDir,
        storageDir,
      );

      dir = dirSync({
        unsafeCleanup: true,
      });
    });

    it("should remove single database after confirmation", async () => {
      const mockDbItem = createMockDB(dir);
      mockDbItem.name = "db-name";
      await databaseUI["handleRemoveDatabase"]([mockDbItem]);

      expect(showBinaryChoiceDialogSpy).toHaveBeenCalledWith(
        "Removing db-name database. Are you sure?",
      );
      expect(mockDatabaseManager.removeDatabaseItem).toHaveBeenCalledWith(
        mockDbItem,
      );
    });

    it("should remove multiple databases after confirmation", async () => {
      const mockDbItem1 = createMockDB(dir);
      const mockDbItem2 = createMockDB(dir);
      await databaseUI["handleRemoveDatabase"]([mockDbItem1, mockDbItem2]);

      expect(showBinaryChoiceDialogSpy).toHaveBeenCalledWith(
        "Removing 2 databases. Are you sure?",
      );
      expect(mockDatabaseManager.removeDatabaseItem).toHaveBeenCalledTimes(2);
      expect(mockDatabaseManager.removeDatabaseItem).toHaveBeenCalledWith(
        mockDbItem1,
      );
      expect(mockDatabaseManager.removeDatabaseItem).toHaveBeenCalledWith(
        mockDbItem2,
      );
    });

    it("should not remove databases if user cancels", async () => {
      const mockDbItem = createMockDB(dir);
      showBinaryChoiceDialogSpy.mockResolvedValueOnce(false);

      await databaseUI["handleRemoveDatabase"]([mockDbItem]);

      expect(showBinaryChoiceDialogSpy).toHaveBeenCalled();
      expect(mockDatabaseManager.removeDatabaseItem).not.toHaveBeenCalled();
    });
  });

  function createDatabase(
    storageDir: string,
    dbName: string,
    language: string,
    extraFile?: string,
  ) {
    const parentDir = join(storageDir, dbName);
    const dbDir = join(parentDir, `db-${language}`);
    mkdirsSync(dbDir);

    if (extraFile) {
      createFileSync(join(parentDir, extraFile));
    }

    return parentDir;
  }
});
