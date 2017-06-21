import { LanguageModelCache, getLanguageModelCache } from '../languageModelCache';
import { SymbolInformation, SymbolKind, CompletionItem, Location, SignatureHelp, SignatureInformation, ParameterInformation, Definition, TextEdit, TextDocument, Diagnostic, DiagnosticSeverity, Range, CompletionItemKind, Hover, MarkedString, DocumentHighlight, DocumentHighlightKind, CompletionList, Position, FormattingOptions } from 'vscode-languageserver-types';
import { LanguageMode } from '../languageModes';
import { getWordAtText } from '../../utils/strings';
import { VueDocumentRegions } from '../embeddedSupport';

import { createLanguageService } from './languageService';

import Uri from 'vscode-uri';
import * as ts from 'typescript';
import * as _ from 'lodash';
import { platform } from 'os';

import { NULL_SIGNATURE, NULL_COMPLETION } from '../nullMode';


const IS_WINDOWS = platform() === 'win32';
const JS_WORD_REGEX = /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g;

export interface ScriptMode extends LanguageMode {
  findComponents(document: TextDocument): string[];
}

export function getJavascriptMode (documentRegions: LanguageModelCache<VueDocumentRegions>, workspacePath: string): ScriptMode {
  const jsDocuments = getLanguageModelCache(10, 60, document => {
    const vueDocument = documentRegions.get(document);
    if (vueDocument.getLanguagesInDocument().indexOf('typescript') > -1) {
      return vueDocument.getEmbeddedDocument('typescript');
    }
    return vueDocument.getEmbeddedDocument('javascript');
  });

  const {languageService: jsLanguageService, updateCurrentTextDocument} = createLanguageService(jsDocuments, workspacePath);
  let settings: any = {};

  return {
    getId () {
      return 'javascript';
    },
    configure (options: any) {
      if (options.vetur) {
        settings.format = options.vetur.format.js;
      }
    },
    doValidation (doc: TextDocument): Diagnostic[] {
      updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(jsLanguageService, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const diagnostics = [...jsLanguageService.getSyntacticDiagnostics(fileFsPath),
      ...jsLanguageService.getSemanticDiagnostics(fileFsPath)];

      return diagnostics.map(diag => {
        return {
          range: convertRange(currentTextDocument, diag),
          severity: DiagnosticSeverity.Error,
          message: ts.flattenDiagnosticMessageText(diag.messageText, '\n')
        };
      });
    },
    doComplete (doc: TextDocument, position: Position): CompletionList {
      updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(jsLanguageService, doc.uri)) {
        return { isIncomplete: false, items: [] };
      }

      const fileFsPath = getFileFsPath(doc.uri);
      let offset = currentTextDocument.offsetAt(position);
      let completions = jsLanguageService.getCompletionsAtPosition(fileFsPath, offset);
      if (!completions) {
        return { isIncomplete: false, items: [] };
      }
      let replaceRange = convertRange(currentTextDocument, getWordAtText(currentTextDocument.getText(), offset, JS_WORD_REGEX));
      return {
        isIncomplete: false,
        items: completions.entries.map(entry => {
          return {
            uri: doc.uri,
            position: position,
            label: entry.name,
            sortText: entry.sortText,
            kind: convertKind(entry.kind),
            textEdit: TextEdit.replace(replaceRange, entry.name),
            data: { // data used for resolving item details (see 'doResolve')
              languageId: 'javascript',
              uri: doc.uri,
              offset: offset
            }
          };
        })
      };
    },
    doResolve (doc: TextDocument, item: CompletionItem): CompletionItem {
      updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(jsLanguageService, doc.uri)) {
        return NULL_COMPLETION;
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const details = jsLanguageService.getCompletionEntryDetails(fileFsPath, item.data.offset, item.label);
      if (details) {
        item.detail = ts.displayPartsToString(details.displayParts);
        item.documentation = ts.displayPartsToString(details.documentation);
        delete item.data;
      }
      return item;
    },
    doHover (doc: TextDocument, position: Position): Hover {
      updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(jsLanguageService, doc.uri)) {
        return { contents: [] };
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const info = jsLanguageService.getQuickInfoAtPosition(fileFsPath, currentTextDocument.offsetAt(position));
      if (info) {
        const display = ts.displayPartsToString(info.displayParts);
        const doc = ts.displayPartsToString(info.documentation);
        const contents = doc ? [doc, '\n', display] : [display];
        const markedContents: MarkedString[] = contents.map(c => {
          return {
            language: 'js',
            value: c
          };
        });
        return {
          range: convertRange(currentTextDocument, info.textSpan),
          contents: markedContents
        };
      }
      return { contents: [] };
    },
    doSignatureHelp (doc: TextDocument, position: Position): SignatureHelp {
      updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(jsLanguageService, doc.uri)) {
        return NULL_SIGNATURE;
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const signHelp = jsLanguageService.getSignatureHelpItems(fileFsPath, currentTextDocument.offsetAt(position));
      if (!signHelp) {
        return NULL_SIGNATURE;
      }
      const ret: SignatureHelp = {
        activeSignature: signHelp.selectedItemIndex,
        activeParameter: signHelp.argumentIndex,
        signatures: []
      };
      signHelp.items.forEach(item => {

        const signature: SignatureInformation = {
          label: '',
          documentation: undefined,
          parameters: []
        };

        signature.label += ts.displayPartsToString(item.prefixDisplayParts);
        item.parameters.forEach((p, i, a) => {
          const label = ts.displayPartsToString(p.displayParts);
          const parameter: ParameterInformation = {
            label: label,
            documentation: ts.displayPartsToString(p.documentation)
          };
          signature.label += label;
          signature.parameters!.push(parameter);
          if (i < a.length - 1) {
            signature.label += ts.displayPartsToString(item.separatorDisplayParts);
          }
        });
        signature.label += ts.displayPartsToString(item.suffixDisplayParts);
        ret.signatures.push(signature);
      });
      return ret;
    },
    findDocumentHighlight (doc: TextDocument, position: Position): DocumentHighlight[] {
      updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(jsLanguageService, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const occurrences = jsLanguageService.getOccurrencesAtPosition(fileFsPath, currentTextDocument.offsetAt(position));
      if (occurrences) {
        return occurrences.map(entry => {
          return {
            range: convertRange(currentTextDocument, entry.textSpan),
            kind: <DocumentHighlightKind>(entry.isWriteAccess ? DocumentHighlightKind.Write : DocumentHighlightKind.Text)
          };
        });
      }
      return [];
    },
    findDocumentSymbols (doc: TextDocument): SymbolInformation[] {
      updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(jsLanguageService, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const items = jsLanguageService.getNavigationBarItems(fileFsPath);
      if (items) {
        const result: SymbolInformation[] = [];
        const existing: {[k: string]: boolean} = {};
        const collectSymbols = (item: ts.NavigationBarItem, containerLabel?: string) => {
          const sig = item.text + item.kind + item.spans[0].start;
          if (item.kind !== 'script' && !existing[sig]) {
            const symbol: SymbolInformation = {
              name: item.text,
              kind: convertSymbolKind(item.kind),
              location: {
                uri: doc.uri,
                range: convertRange(currentTextDocument, item.spans[0])
              },
              containerName: containerLabel
            };
            existing[sig] = true;
            result.push(symbol);
            containerLabel = item.text;
          }

          if (item.childItems && item.childItems.length > 0) {
            for (let child of item.childItems) {
              collectSymbols(child, containerLabel);
            }
          }

        };

        items.forEach(item => collectSymbols(item));
        return result;
      }
      return [];
    },
    findDefinition (doc: TextDocument, position: Position): Definition {
      updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(jsLanguageService, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const definition = jsLanguageService.getDefinitionAtPosition(fileFsPath, currentTextDocument.offsetAt(position));
      if (!definition) {
        return [];
      }
      return definition.map(d => {
        return {
          uri: doc.uri,
          range: convertRange(currentTextDocument, d.textSpan)
        };
      });
    },
    findReferences (doc: TextDocument, position: Position): Location[] {
      updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(jsLanguageService, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const references = jsLanguageService.getReferencesAtPosition(fileFsPath, currentTextDocument.offsetAt(position));
      if (references) {
        return references.map(d => {
          return {
            uri: doc.uri,
            range: convertRange(currentTextDocument, d.textSpan)
          };
        });
      }
      return [];
    },
    format (doc: TextDocument, range: Range, formatParams: FormattingOptions): TextEdit[] {
      updateCurrentTextDocument(doc);

      const fileFsPath = getFileFsPath(doc.uri);
      const initialIndentLevel = formatParams.scriptInitialIndent ? 1 : 0;
      const formatSettings = convertOptions(formatParams, settings && settings.format, initialIndentLevel);
      const start = currentTextDocument.offsetAt(range.start);
      let end = currentTextDocument.offsetAt(range.end);
      const edits = jsLanguageService.getFormattingEditsForRange(fileFsPath, start, end, formatSettings);
      if (edits) {
        const result = [];
        for (let edit of edits) {
          if (edit.span.start >= start && edit.span.start + edit.span.length <= end) {
            result.push({
              range: convertRange(currentTextDocument, edit.span),
              newText: edit.newText
            });
          }
        }
        return result;
      }
      return [];
    },
    findComponents(doc: TextDocument) {
      const fileFsPath = getFileFsPath(doc.uri);
      const program = jsLanguageService.getProgram();
      const sourceFile = program.getSourceFile(fileFsPath);
      const importStmt = sourceFile.statements.filter(st => st.kind === ts.SyntaxKind.ExportAssignment);
      const instance = (importStmt[0] as ts.ExportAssignment).expression as ts.CallExpression;
      const comp = instance.arguments![0];
      const checker = program.getTypeChecker();
      const compType = checker.getTypeAtLocation(comp);
      const compsSymbol = checker.getPropertyOfType(compType, 'components');
      const comps = checker.getTypeOfSymbolAtLocation(compsSymbol, compsSymbol.declarations![0]);
      return checker.getPropertiesOfType(comps).map(s => s.name);
    },
    onDocumentRemoved (document: TextDocument) {
      jsDocuments.onDocumentRemoved(document);
    },
    dispose () {
      jsLanguageService.dispose();
      jsDocuments.dispose();
    }
  };

}



function getFileFsPath (documentUri: string): string {
  return Uri.parse(documentUri).fsPath;
}

function getFilePath (documentUri: string): string {
  if (IS_WINDOWS) {
    // Windows have a leading slash like /C:/Users/pine
    return Uri.parse(documentUri).path.slice(1);
  } else {
    return Uri.parse(documentUri).path;
  }
}

function languageServiceIncludesFile (ls: ts.LanguageService, documentUri: string): boolean {
  const filePaths = ls.getProgram().getRootFileNames();
  const filePath = getFilePath(documentUri);
  return filePaths.includes(filePath);
}

function convertRange (document: TextDocument, span: ts.TextSpan): Range {
  const startPosition = document.positionAt(span.start);
  const endPosition = document.positionAt(span.start + span.length);
  return Range.create(startPosition, endPosition);
}

function convertKind (kind: string): CompletionItemKind {
  switch (kind) {
    case 'primitive type':
    case 'keyword':
      return CompletionItemKind.Keyword;
    case 'var':
    case 'local var':
      return CompletionItemKind.Variable;
    case 'property':
    case 'getter':
    case 'setter':
      return CompletionItemKind.Field;
    case 'function':
    case 'method':
    case 'construct':
    case 'call':
    case 'index':
      return CompletionItemKind.Function;
    case 'enum':
      return CompletionItemKind.Enum;
    case 'module':
      return CompletionItemKind.Module;
    case 'class':
      return CompletionItemKind.Class;
    case 'interface':
      return CompletionItemKind.Interface;
    case 'warning':
      return CompletionItemKind.File;
  }

  return CompletionItemKind.Property;
}

function convertSymbolKind (kind: string): SymbolKind {
  switch (kind) {
    case 'var':
    case 'local var':
    case 'const':
      return SymbolKind.Variable;
    case 'function':
    case 'local function':
      return SymbolKind.Function;
    case 'enum':
      return SymbolKind.Enum;
    case 'module':
      return SymbolKind.Module;
    case 'class':
      return SymbolKind.Class;
    case 'interface':
      return SymbolKind.Interface;
    case 'method':
      return SymbolKind.Method;
    case 'property':
    case 'getter':
    case 'setter':
      return SymbolKind.Property;
  }
  return SymbolKind.Variable;
}

function convertOptions (options: FormattingOptions, formatSettings: any, initialIndentLevel: number): ts.FormatCodeOptions {
  const defaultJsFormattingOptions = {
    ConvertTabsToSpaces: options.insertSpaces,
    TabSize: options.tabSize,
    IndentSize: options.tabSize,
    IndentStyle: ts.IndentStyle.Smart,
    NewLineCharacter: '\n',
    BaseIndentSize: options.tabSize * initialIndentLevel,
    InsertSpaceAfterCommaDelimiter: true,
    InsertSpaceAfterSemicolonInForStatements: true,
    InsertSpaceAfterKeywordsInControlFlowStatements: true,
    InsertSpaceAfterFunctionKeywordForAnonymousFunctions: true,
    InsertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis: false,
    InsertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets: false,
    InsertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces: false,
    InsertSpaceBeforeFunctionParenthesis: true,
    InsertSpaceBeforeAndAfterBinaryOperators: true,
    PlaceOpenBraceOnNewLineForControlBlocks: false,
    PlaceOpenBraceOnNewLineForFunctions: false
  };

  return _.assign(defaultJsFormattingOptions, formatSettings);
}
