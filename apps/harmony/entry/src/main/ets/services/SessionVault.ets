import { asset } from '@kit.AssetStoreKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';

export interface StoredSession {
  token: string;
  baseUrl: string;
}

/** Device-scoped encrypted storage. No token is written to Preferences or logs. */
export class SessionVault {
  private queue: Promise<void> = Promise.resolve();
  private alias: Uint8Array = new util.TextEncoder().encodeInto('yuqu.account.session.v1');

  load(): Promise<StoredSession | undefined> {
    const result: Promise<StoredSession | undefined> = this.queue.then(async () => {
      const query: asset.AssetMap = new Map();
      query.set(asset.Tag.ALIAS, this.alias);
      query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
      try {
        const items: asset.AssetMap[] = await asset.query(query);
        if (items.length === 0) return undefined;
        const bytes: Uint8Array = items[0].get(asset.Tag.SECRET) as Uint8Array;
        const value: StoredSession = JSON.parse(util.TextDecoder.create('utf-8').decodeToString(bytes)) as StoredSession;
        if (typeof value.token !== 'string' || value.token.length === 0 ||
          typeof value.baseUrl !== 'string' || value.baseUrl.length === 0) {
          throw new Error('安全存储中的登录信息无效，请重新登录');
        }
        return value;
      } catch (error) {
        if ((error as BusinessError).code === asset.ErrorCode.NOT_FOUND) return undefined;
        throw error as Error;
      }
    });
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  save(session: StoredSession): Promise<void> {
    const result: Promise<void> = this.queue.then(async () => {
      const attributes: asset.AssetMap = new Map();
      attributes.set(asset.Tag.ALIAS, this.alias);
      attributes.set(asset.Tag.SECRET, new util.TextEncoder().encodeInto(JSON.stringify(session)));
      attributes.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_FIRST_UNLOCKED);
      attributes.set(asset.Tag.AUTH_TYPE, asset.AuthType.NONE);
      attributes.set(asset.Tag.SYNC_TYPE, asset.SyncType.NEVER);
      attributes.set(asset.Tag.CONFLICT_RESOLUTION, asset.ConflictResolution.OVERWRITE);
      await asset.add(attributes);
    });
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  clear(): Promise<void> {
    // Serialize after a pending save so logout cannot be undone by a late asset.add.
    const result: Promise<void> = this.queue.then(async () => {
      const query: asset.AssetMap = new Map();
      query.set(asset.Tag.ALIAS, this.alias);
      try { await asset.remove(query); }
      catch (error) {
        if ((error as BusinessError).code !== asset.ErrorCode.NOT_FOUND) throw error as Error;
      }
    });
    this.queue = result.then(() => {}, () => {});
    return result;
  }
}
