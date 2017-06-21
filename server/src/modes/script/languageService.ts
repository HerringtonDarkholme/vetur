import * as path from 'path';
import * as ts from 'typescript';
import {  TextDocument } from 'vscode-languageserver-types';
import Uri from 'vscode-uri';
import * as _ from 'lodash';

import * as bridge from './bridge';
import { createUpdater, parseVue, isVue } from './typescript';
import { LanguageModelCache } from '../languageModelCache';

export function createLanguageService(jsDocuments: LanguageModelCache<TextDocument>, workspacePath: string) {
  let compilerOptions: ts.CompilerOptions = {
    allowNonTsExtensions: true,
    allowJs: true,
    lib: ['lib.dom.d.ts', 'lib.es2017.d.ts'],
    target: ts.ScriptTarget.Latest,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    module: ts.ModuleKind.CommonJS,
    allowSyntheticDefaultImports: true
  };
  let currentTextDocument: TextDocument;
  let versions = new Map<string, number>();
  let docs = new Map<string, TextDocument>();
  let jsLanguageService: ts.LanguageService;

  // Patch typescript functions to insert `import Vue from 'vue'` and `new Vue` around export default.
  // NOTE: Typescript 2.3 should add an API to allow this, and then this code should use that API.
  const { createLanguageServiceSourceFile, updateLanguageServiceSourceFile } = createUpdater();
  (ts as any).createLanguageServiceSourceFile = createLanguageServiceSourceFile;
  (ts as any).updateLanguageServiceSourceFile = updateLanguageServiceSourceFile;
  const configFilename = ts.findConfigFile(workspacePath, ts.sys.fileExists, 'tsconfig.json') ||
    ts.findConfigFile(workspacePath, ts.sys.fileExists, 'jsconfig.json');
  const configJson = configFilename && ts.readConfigFile(configFilename, ts.sys.readFile).config || {
    exclude: ['node_modules', '**/node_modules/*']
  };
  const parsedConfig = ts.parseJsonConfigFileContent(configJson,
    ts.sys,
    workspacePath,
    compilerOptions,
    configFilename,
    undefined,
    [{ extension: 'vue', isMixedContent: true }]);
  const files = parsedConfig.fileNames;
  compilerOptions = parsedConfig.options;
  compilerOptions.allowNonTsExtensions = true;

  function updateCurrentTextDocument (doc: TextDocument) {
    const fileFsPath = getFileFsPath(doc.uri);
    // When file is not in language service, add it
    if (!docs.has(fileFsPath)) {
      if (_.endsWith(fileFsPath, '.vue')) {
        files.push(fileFsPath);
      }
    }
    if (!currentTextDocument || doc.uri !== currentTextDocument.uri || doc.version !== currentTextDocument.version) {
      currentTextDocument = jsDocuments.get(doc);
      let lastDoc = docs.get(fileFsPath);
      if (lastDoc && currentTextDocument.languageId !== lastDoc.languageId) {
        // if languageId changed, restart the language service; it can't handle file type changes
        compilerOptions.allowJs = lastDoc.languageId !== 'typescript';
        // jsLanguageService.dispose();
        jsLanguageService.cleanupSemanticCache();
        // jsLanguageService = ts.createLanguageService(host);
      }
      docs.set(fileFsPath, currentTextDocument);
      versions.set(fileFsPath, (versions.get(fileFsPath) || 0) + 1);
    }
  }

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => files,
    getScriptVersion (fileName) {
      if (fileName === bridge.fileName) {
        return '0';
      }
      const normalizedFileFsPath = getNormalizedFileFsPath(fileName);
      let version = versions.get(normalizedFileFsPath);
      return version ? version.toString() : '0';
    },
    getScriptKind (fileName) {
      if (isVue(fileName)) {
        const uri = Uri.file(fileName);
        fileName = uri.fsPath;
        const doc = docs.get(fileName) ||
          jsDocuments.get(TextDocument.create(uri.toString(), 'vue', 0, ts.sys.readFile(fileName)));
        return doc.languageId === 'typescript' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
      }
      else {
        if (fileName === bridge.fileName) {
          return ts.Extension.Ts;
        }
        // NOTE: Typescript 2.3 should export getScriptKindFromFileName. Then this cast should be removed.
        return (ts as any).getScriptKindFromFileName(fileName);
      }
    },
    resolveModuleNames (moduleNames: string[], containingFile: string): ts.ResolvedModule[] {
      // in the normal case, delegate to ts.resolveModuleName
      // in the relative-imported.vue case, manually build a resolved filename
      return moduleNames.map(name => {
        if (name === bridge.moduleName) {
          return {
            resolvedFileName: bridge.fileName,
            extension: ts.Extension.Ts
          };
        }
        if (path.isAbsolute(name) || !isVue(name)) {
          return ts.resolveModuleName(name, containingFile, compilerOptions, ts.sys).resolvedModule!;
        }
        const uri = Uri.file(path.join(path.dirname(containingFile), name));
        const resolvedFileName = uri.fsPath;
        if (ts.sys.fileExists(resolvedFileName)) {
          const doc = docs.get(resolvedFileName) ||
            jsDocuments.get(TextDocument.create(uri.toString(), 'vue', 0, ts.sys.readFile(resolvedFileName)));
          return {
            resolvedFileName,
            extension: doc.languageId === 'typescript' ? ts.Extension.Ts : ts.Extension.Js,
          };
        }
        return undefined as any;
      });
    },
    getScriptSnapshot: (fileName: string) => {
      if (fileName === bridge.fileName) {
        let text = bridge.content;
        return {
          getText: (start, end) => text.substring(start, end),
          getLength: () => text.length,
          getChangeRange: () => void 0
        };
      }
      const normalizedFileFsPath = getNormalizedFileFsPath(fileName);
      let doc = docs.get(normalizedFileFsPath);
      let text = doc ? doc.getText() : (ts.sys.readFile(normalizedFileFsPath) || '');
      if (isVue(fileName)) {
        // Note: This is required in addition to the parsing in embeddedSupport because
        // this works for .vue files that aren't even loaded by VS Code yet.
        text = parseVue(text);
      }
      return {
        getText: (start, end) => text.substring(start, end),
        getLength: () => text.length,
        getChangeRange: () => void 0
      };
    },
    getCurrentDirectory: () => workspacePath,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
  };

  jsLanguageService = ts.createLanguageService(host);
  return {
    languageService: jsLanguageService,
    updateCurrentTextDocument
  };
}

function getFileFsPath (documentUri: string): string {
  return Uri.parse(documentUri).fsPath;
}

function getNormalizedFileFsPath (fileName: string): string {
  return Uri.file(fileName).fsPath;
}
