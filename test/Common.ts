import deepStrictEqual = require('deep-equal');
import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import * as path from 'path';
import * as fse from 'fs-extra';
import { inspect, promisify } from 'util';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import { ChildProcess } from 'child_process';

import { TestLoadFinishedEvent, TestLoadStartedEvent, TestSuiteInfo, TestInfo } from 'vscode-test-adapter-api';

import * as my from '../src/TestAdapter';
import { Config } from '../src/Configurations';
import { TestRunEvent } from '../src/SharedVariables';

///

export const isWin = process.platform === 'win32';

///
assert.notStrictEqual(vscode.workspace.workspaceFolders, undefined);
assert.equal(vscode.workspace.workspaceFolders!.length, 1);

export const settings = new (class {
  public readonly workspaceFolderUri = vscode.workspace.workspaceFolders![0].uri;
  public readonly workspaceFolder = vscode.workspace.getWorkspaceFolder(this.workspaceFolderUri)!;
  public readonly dotVscodePath = path.join(this.workspaceFolderUri.fsPath, '.vscode');

  public getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('testMate.cpp', this.workspaceFolderUri);
  }

  private _getOldConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('catch2TestExplorer', this.workspaceFolderUri);
  }

  // eslint-disable-next-line
  public updateConfig(key: Config, value: any): Promise<void> {
    return new Promise(r => this.getConfig().update(key, value).then(r));
  }

  public resetConfig(): Promise<void> {
    const packageJson = fse.readJSONSync(path.join(__dirname, '../..', 'package.json'));
    const properties: { [prop: string]: string }[] = packageJson['contributes']['configuration']['properties'];
    let t: Thenable<void> = Promise.resolve();
    Object.keys(properties).forEach(key => {
      assert.ok(key.startsWith('testMate.cpp.') || key.startsWith('catch2TestExplorer.'));

      if (key.startsWith('testMate.cpp.')) {
        const k = key.substr('testMate.cpp.'.length);
        // don't want to override these
        if (k !== 'log.logfile' && k !== 'log.logSentry' && k !== 'log.userId')
          t = t.then(() => this.getConfig().update(k, undefined));
      } else if (key.startsWith('catch2TestExplorer.')) {
        const k = key.substr('catch2TestExplorer.'.length);
        t = t.then(() => this._getOldConfig().update(k, undefined));
      }
    });
    return new Promise(r => t.then(r));
  }
})();

export const globalExpectedLoggedErrorLine = new Set<string>();

export function expectedLoggedErrorLine(errorLine: string): void {
  globalExpectedLoggedErrorLine.add(errorLine);
}

export async function waitFor(context: Mocha.Context, condition: Function, timeout?: number): Promise<void> {
  if (timeout === undefined) timeout = context.timeout() - 1000 /*need some time for error handling*/;
  const start = Date.now();
  let c = await condition();
  while (!(c = await condition()) && (Date.now() - start < timeout || !context.enableTimeouts()))
    await promisify(setTimeout)(32);
  if (!c) throw Error('in test: ' + (context.test ? context.test.title : '?') + '. Condition: ' + condition.toString());
}

export async function waitForMilisec(context: Mocha.Context, milisec: number): Promise<void> {
  const start = Date.now();
  return waitFor(context, () => Date.now() - start > milisec);
}

///

export class FileSystemWatcherStub implements vscode.FileSystemWatcher {
  public constructor(
    private readonly path: vscode.Uri,
    readonly ignoreCreateEvents: boolean = false,
    readonly ignoreChangeEvents: boolean = false,
    readonly ignoreDeleteEvents: boolean = false,
  ) {}

  private readonly _onDidCreateEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly _onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly _onDidDeleteEmitter = new vscode.EventEmitter<vscode.Uri>();

  public sendCreate(): void {
    this._onDidCreateEmitter.fire(this.path);
  }
  public sendChange(): void {
    this._onDidChangeEmitter.fire(this.path);
  }
  public sendDelete(): void {
    this._onDidDeleteEmitter.fire(this.path);
  }

  public get onDidCreate(): vscode.Event<vscode.Uri> {
    return this._onDidCreateEmitter.event;
  }
  public get onDidChange(): vscode.Event<vscode.Uri> {
    return this._onDidChangeEmitter.event;
  }
  public get onDidDelete(): vscode.Event<vscode.Uri> {
    return this._onDidDeleteEmitter.event;
  }

  public dispose(): void {
    this._onDidCreateEmitter.dispose();
    this._onDidChangeEmitter.dispose();
    this._onDidDeleteEmitter.dispose();
  }
}

///

export class Imitation {
  public readonly sinonSandbox = sinon.createSandbox();

  public readonly spawnStub = this.sinonSandbox.stub(cp, 'spawn').named('spawnStub');

  public readonly vsfsWatchStub = this.sinonSandbox
    .stub(vscode.workspace, 'createFileSystemWatcher')
    .named('vscode.createFileSystemWatcher');

  public readonly fsAccessStub = (this.sinonSandbox.stub(fs, 'access').named('access') as unknown) as sinon.SinonStub<
    [fs.PathLike, string, (err: NodeJS.ErrnoException | null) => void],
    void
  >;

  public readonly fsReadFileSyncStub = this.sinonSandbox.stub(fs, 'readFileSync').named('fsReadFileSync');

  public readonly vsFindFilesStub = this.sinonSandbox.stub(vscode.workspace, 'findFiles').named('vsFindFilesStub');

  public constructor() {
    this.resetToCallThrough();
  }

  public restore(): void {
    this.sinonSandbox.restore();
  }

  public resetToCallThrough(): void {
    this.sinonSandbox.reset();
    this.spawnStub.callThrough();
    this.vsfsWatchStub.callThrough();
    this.fsAccessStub.callThrough();
    this.fsReadFileSyncStub.callThrough();
    this.vsFindFilesStub.callThrough();
  }

  public createVscodeRelativePatternMatcher(p: string): sinon.SinonMatcher {
    const required = new vscode.RelativePattern(settings.workspaceFolder, p);
    return sinon.match((actual: vscode.RelativePattern) => {
      return required.base == actual.base && required.pattern == actual.pattern;
    });
  }

  public createAbsVscodeRelativePatternMatcher(p: string): sinon.SinonMatcher {
    return this.createVscodeRelativePatternMatcher(path.relative(settings.workspaceFolderUri.fsPath, p));
  }

  public handleAccessFileExists(
    path: fse.PathLike,
    flag: string,
    cb: (err: NodeJS.ErrnoException | null) => void,
  ): void {
    cb(null);
  }

  public handleAccessFileNotExists(
    path: fse.PathLike,
    flag: string,
    cb: (err: NodeJS.ErrnoException | null) => void,
  ): void {
    cb({
      name: 'errname',
      code: 'ENOENT',
      errno: -2,
      message: 'ENOENT',
      path: path.toString(),
      syscall: 'stat',
    });
  }

  public createCreateFSWatcherHandler(
    watchers: Map<string, FileSystemWatcherStub>,
  ): (
    p: vscode.GlobPattern,
    ignoreCreateEvents?: boolean | undefined,
    ignoreChangeEvents?: boolean | undefined,
    ignoreDeleteEvents?: boolean | undefined,
  ) => FileSystemWatcherStub {
    return (
      p: vscode.GlobPattern,
      ignoreCreateEvents?: boolean | undefined,
      ignoreChangeEvents?: boolean | undefined,
      ignoreDeleteEvents?: boolean | undefined,
    ): FileSystemWatcherStub => {
      const pp = typeof p === 'string' ? p : path.join(p.base, p.pattern);
      const e = new FileSystemWatcherStub(
        vscode.Uri.file(pp),
        ignoreCreateEvents,
        ignoreChangeEvents,
        ignoreDeleteEvents,
      );
      watchers.set(pp, e);
      return e;
    };
  }
}

///

export class TestAdapter extends my.TestAdapter {
  public readonly testLoadsEvents: (TestLoadStartedEvent | TestLoadFinishedEvent)[] = [];
  private readonly testLoadsEventsConnection: vscode.Disposable;

  private readonly _testStatesEvents: TestRunEvent[] = [];
  private readonly testStatesEventsConnection: vscode.Disposable;

  public constructor() {
    super(settings.workspaceFolder);

    this.testLoadsEventsConnection = this.tests((e: TestLoadStartedEvent | TestLoadFinishedEvent) => {
      this.testLoadsEvents.push(e);
    });

    this.testStatesEventsConnection = this.testStates((e: TestRunEvent) => {
      this._testStatesEvents.push(e);
    });
  }

  public dispose(): void {
    throw Error('should have called waitAndDispose');
  }

  public async waitAndDispose(context: Mocha.Context): Promise<void> {
    await waitFor(context, () => {
      return (this as any) /* eslint-disable-line */._mainTaskQueue._count == 0;
    });

    super.dispose();

    this.testLoadsEventsConnection.dispose();
    this.testStatesEventsConnection.dispose();

    // check
    for (let i = 0; i < this.testLoadsEvents.length; i++) {
      assert.deepStrictEqual(
        this.testLoadsEvents[i],
        { type: 'started' },
        inspect({ index: i, testsEvents: this.testLoadsEvents }),
      );
      i++;
      assert.ok(i < this.testLoadsEvents.length, inspect({ index: i, testLoadsEvents: this.testLoadsEvents }));
      assert.equal(this.testLoadsEvents[i].type, 'finished', inspect({ index: i, testsEvents: this.testLoadsEvents }));
    }
  }

  public get root(): TestSuiteInfo {
    return (this as any) /* eslint-disable-line */._rootSuite;
  }

  public getGroup(...index: number[]): TestSuiteInfo {
    let group: TestSuiteInfo = this.root;
    for (let i = 0; i < index.length; i++) {
      assert.ok(group.children.length > index[i], index[i].toString());
      const next = group.children[index[i]];
      if (next.type === 'suite') group = next;
      else throw Error(`wrong type for ${index}[${i}]`);
    }
    return group;
  }

  public getTest(...index: number[]): TestInfo {
    let group: TestSuiteInfo = this.root;
    for (let i = 0; i < index.length; i++) {
      assert.ok(group.children.length > index[i], index[i].toString());
      const next = group.children[index[i]];
      if (i + 1 === index.length) {
        if (next.type === 'test') return next;
        else throw Error(`wrong type for ${index}[${i}]`);
      } else {
        if (next.type === 'suite') group = next;
        else throw Error(`wrong type for ${index}[${i}]`);
      }
    }
    throw Error(`coudn't find test ${index}`);
  }

  public get group1(): TestSuiteInfo {
    return this.getGroup(0);
  }
  public get group2(): TestSuiteInfo {
    return this.getGroup(1);
  }
  public get group3(): TestSuiteInfo {
    return this.getGroup(2);
  }
  public get group4(): TestSuiteInfo {
    return this.getGroup(3);
  }

  public get testStatesEvents(): TestRunEvent[] {
    return this._testStatesEvents.map((v: TestRunEvent) => {
      if ((v.type === 'test' || v.type === 'suite') && v.tooltip)
        return Object.assign(v, { tooltip: v.tooltip.replace(/(Path|Cwd): .*/g, '$1: <masked>') });
      return v;
    });
  }

  public testStatesEventsAssertDeepEqual(expected: TestRunEvent[]): void {
    if (this._testStatesEvents.length != expected.length)
      console.log(
        `this._testStatesEvents.length(${this._testStatesEvents.length}) != expected.length(${expected.length})`,
      );

    const testStatesEvents = this.testStatesEvents;

    for (let i = 0; i < expected.length && i < testStatesEvents.length; ++i) {
      assert.deepStrictEqual(testStatesEvents[i], expected[i], `index: ${i}`);
    }
  }

  public testStatesEventsSimplifiedAssertEqual(expectedArr: TestRunEvent[]): void {
    if (this._testStatesEvents.length != expectedArr.length)
      console.log(
        `this._testStatesEvents.length(${this._testStatesEvents.length}) != expected.length(${expectedArr.length})`,
      );

    const testStatesEvents = this._testStatesEvents;

    try {
      for (let i = 0; i < expectedArr.length && i < testStatesEvents.length; ++i) {
        const actual = testStatesEvents[i];
        const expected = expectedArr[i];

        if (actual.type == 'test' && expected.type == 'test') {
          // eslint-disable-next-line
          assert.strictEqual((actual.test as any).id, (expected.test as any).id, `index: ${i}`);
          assert.strictEqual(actual.state, expected.state, `index: ${i}`);
        } else if (actual.type == 'suite' && expected.type == 'suite') {
          // eslint-disable-next-line
          assert.strictEqual((actual.suite as any).id, (expected.suite as any).id, `index: ${i}`);
          assert.strictEqual(actual.state, expected.state, `index: ${i}`);
        } else {
          assert.deepStrictEqual(actual, expected, `index: ${i}`);
        }
      }

      assert.strictEqual(this._testStatesEvents.length, expectedArr.length);
    } catch (e) {
      debugger;
      throw e;
    }
  }

  public getTestStatesEventIndex(searchFor: TestRunEvent): number {
    const i = this.testStatesEvents.findIndex((v: TestRunEvent) => {
      if (v.type !== searchFor.type) return false;
      if (v.type === 'suite' && searchFor.type === 'suite') {
        if (v.suite !== searchFor.suite) return false;
        if (v.state !== searchFor.state) return false;
      }
      if (v.type === 'test' && searchFor.type === 'test') {
        if (v.test !== searchFor.test) return false;
        if (v.state !== searchFor.state) return false;
      }
      if (v.type === 'started' && searchFor.type === 'started') {
        if (!deepStrictEqual(v.tests, searchFor.tests)) return false;
      }
      return true;
    });
    assert.ok(
      0 <= i,
      `getTestStatesEventIndex failed to find: ` +
        inspect(searchFor, false, 0) +
        '\nin:\n' +
        inspect(this.testStatesEvents, false, 1),
    );
    return i;
  }

  public testStateEventIndexLess(less: TestRunEvent, thanThis: TestRunEvent): void {
    const l = this.getTestStatesEventIndex(less);
    const r = this.getTestStatesEventIndex(thanThis);
    assert.ok(l < r, 'testStateEventIndexLess: ' + inspect({ less: [l, less], thanThis: [r, thanThis] }));
  }

  public async doAndWaitForReloadEvent(context: Mocha.Context, action: Function): Promise<TestSuiteInfo | undefined> {
    const origCount = this.testLoadsEvents.length;
    try {
      await action();
    } catch (e) {
      throw Error('action: "' + action.toString() + '" errored: ' + e.toString());
    }
    try {
      await waitFor(context, () => {
        return this.testLoadsEvents.length >= origCount + 2;
      });
    } catch (e) {
      throw Error('waiting after action: "' + action.toString() + '" errored: ' + e.toString());
    }
    assert.equal(this.testLoadsEvents.length, origCount + 2, action.toString());
    assert.equal(this.testLoadsEvents[this.testLoadsEvents.length - 1].type, 'finished');
    const e = this.testLoadsEvents[this.testLoadsEvents.length - 1] as TestLoadFinishedEvent;
    if (e.suite) {
      assert.strictEqual(e.suite, this.root);
    } else {
      assert.deepStrictEqual([], this.root.children);
    }
    return e.suite;
  }
}

///

export class ChildProcessStub extends EventEmitter implements ChildProcess {
  public readonly stdin: Writable | null = undefined as any; // eslint-disable-line
  public readonly stdio: [
    Writable | null, // stdin
    Readable | null, // stdout
    Readable | null, // stderr
    Readable | Writable | null | undefined, // extra
    Readable | Writable | null | undefined, // extra
  ] = undefined as any; // eslint-disable-line
  public readonly pid: number = undefined as any; // eslint-disable-line
  public readonly connected: boolean = undefined as any; // eslint-disable-line

  // eslint-disable-next-line
  public send(...args: any[]): boolean {
    throw Error('methond not implemented');
  }
  public disconnect(): void {
    throw Error('methond not implemented');
  }
  public unref(): void {
    throw Error('methond not implemented');
  }
  public ref(): void {
    throw Error('methond not implemented');
  }

  public readonly stdout: Readable;
  private _stdoutChunks: (string | null)[] = [];
  private _canPushOut = false;

  public readonly stderr: Readable;
  private _stderrChunks: (string | null)[] = [];
  private _canPushErr = false;
  public closed = false;
  public killed = false;

  private _writeStdOut(): void {
    while (this._stdoutChunks.length && this._canPushOut)
      this._canPushOut = this.stdout.push(this._stdoutChunks.shift());
  }

  private _writeStdErr(): void {
    while (this._stderrChunks.length && this._canPushErr)
      this._canPushErr = this.stderr.push(this._stderrChunks.shift());
  }

  public constructor(stdout?: string | Iterable<string>, close?: number | string, stderr?: string) {
    super();

    if (stdout === undefined) this._stdoutChunks = [];
    else if (typeof stdout === 'string') this._stdoutChunks = [stdout, null];
    else this._stdoutChunks = [...stdout, null];

    if (stderr === undefined) this._stderrChunks = [null];
    else if (typeof stderr === 'string') this._stderrChunks = [stderr, null];
    else throw new Error('assert');

    this.stdout = new Readable({
      read: (): void => {
        this._canPushOut = true;
        this._writeStdOut();
      },
    });
    this.stderr = new Readable({
      read: (): void => {
        this._canPushErr = true;
        this._writeStdErr();
      },
    });

    this.stdout.on('end', () => {
      this.closed = true;
      if (close === undefined) this.emit('close', 1, null);
      else if (typeof close === 'string') this.emit('close', null, close);
      else this.emit('close', close, null);
    });
  }

  public kill(signal?: NodeJS.Signals | number): boolean {
    if (signal === undefined) signal = 'SIGTERM';
    this.killed = true;
    this.emit('close', null, signal);
    this.stdout.push(null);
    this.stderr.push(null);
    return true;
  }

  public write(data: string): void {
    this._stdoutChunks.push(data);
    this._writeStdOut();
  }

  public close(): void {
    this._stdoutChunks.push(null);
    this._writeStdOut();
    this._stderrChunks.push(null);
    this._writeStdErr();
  }

  public writeAndClose(data: string): void {
    this.write(data);
    this.close();
  }

  public writeLineByLineAndClose(data: string): void {
    const lines = data.split('\n');
    lines.forEach(l => {
      this.write(l + '\n');
    });
    this.close();
  }
}
