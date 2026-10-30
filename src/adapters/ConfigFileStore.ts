import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseGroups, serializeGroups, type RawGroup } from '../models/configDocument.ts';

export interface AdapterReadResult {
  groups: RawGroup[];
  text?: string;
  filePath: string;
  exists: boolean;
}

export interface AdapterWriteResult {
  text: string;
  bytesWritten: number;
}

export class ConfigParseFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigParseFailure';
  }
}

/**
 * 语言模型配置文件的纯 Node 读写层。
 *
 * 写入采用“同目录临时文件 + rename”，避免进程中断留下半截 JSON；
 * 备份由调用方显式触发，便于在同一事务内先备份再覆盖。
 */
export class ConfigFileStore {
  private readonly configPath: string;

  constructor(configPath: string) {
    this.configPath = configPath;
  }

  get filePath(): string {
    return this.configPath;
  }

  /** 由扩展的 globalStorageUri 推导默认用户配置路径。 */
  static fromGlobalStorage(globalStoragePath: string): ConfigFileStore {
    // globalStoragePath 形如 <user>/globalStorage/<publisher>.<ext>，
    // 语言模型配置位于 <user>/chatLanguageModels.json。
    return new ConfigFileStore(path.resolve(globalStoragePath, '..', '..', 'chatLanguageModels.json'));
  }

  async read(): Promise<AdapterReadResult> {
    let text: string;
    try {
      text = await fs.readFile(this.configPath, 'utf8');
    } catch (error) {
      if (isNotFound(error)) {
        return { groups: [], exists: false, filePath: this.configPath };
      }
      throw error;
    }
    if (text.trim().length === 0) {
      return { groups: [], text, exists: true, filePath: this.configPath };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ConfigParseFailure(
        `无法解析 ${path.basename(this.configPath)}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      return { groups: parseGroups(parsed), text, exists: true, filePath: this.configPath };
    } catch (error) {
      throw new ConfigParseFailure(
        `${path.basename(this.configPath)} 结构无效：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async write(groups: readonly RawGroup[]): Promise<AdapterWriteResult> {
    const text = serializeGroups(groups);
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    const tempPath = `${this.configPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.writeFile(tempPath, text, 'utf8');
      await fs.rename(tempPath, this.configPath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return { text, bytesWritten: Buffer.byteLength(text, 'utf8') };
  }

  backupDirectory(): string {
    return path.join(path.dirname(this.configPath), 'copilot-model-configurator-backups');
  }

  async createBackup(text: string, keep: number): Promise<string | undefined> {
    if (keep <= 0) {
      return undefined;
    }
    const dir = this.backupDirectory();
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
    const backupPath = path.join(dir, `chatLanguageModels-${stamp}.json`);
    await fs.writeFile(backupPath, text, 'utf8');
    await pruneBackups(dir, keep);
    return backupPath;
  }
}

export function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT';
}

async function pruneBackups(dir: string, keep: number): Promise<void> {
  try {
    const entries = await fs.readdir(dir);
    const backups = entries.filter((entry) => entry.startsWith('chatLanguageModels-') && entry.endsWith('.json')).sort();
    const excess = backups.slice(0, Math.max(0, backups.length - keep));
    await Promise.all(excess.map((entry) => fs.rm(path.join(dir, entry), { force: true })));
  } catch {
    // 备份清理失败不影响主流程。
  }
}
