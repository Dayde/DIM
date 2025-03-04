import { currentAccountSelector } from 'app/accounts/selectors';
import { D2ManifestDefinitions } from 'app/destiny2/d2-definitions';
import { t } from 'app/i18next-t';
import { getDefaultPlugHash } from 'app/loadout/mod-utils';
import { d2ManifestSelector } from 'app/manifest/selectors';
import { ThunkResult } from 'app/store/types';
import { DimError } from 'app/utils/dim-error';
import { mergedCollectiblesSelector } from 'app/vendors/selectors';
import { Destiny2CoreSettings } from 'bungie-api-ts/core';
import {
  AwaAuthorizationResult,
  AwaType,
  AwaUserSelection,
  DestinyInventoryItemDefinition,
  DestinyItemChangeResponse,
  DestinySocketArrayType,
  insertSocketPlug,
  insertSocketPlugFree,
} from 'bungie-api-ts/destiny2';
import { get, set } from 'idb-keyval';
import { DestinyAccount } from '../accounts/destiny-account';
import { authenticatedHttpClient } from '../bungie-api/bungie-service-helper';
import { requestAdvancedWriteActionToken } from '../bungie-api/destiny2-api';
import { showNotification } from '../notifications/notifications';
import { awaItemChanged } from './actions';
import { DimItem, DimSocket } from './item-types';
import { currentStoreSelector, d2BucketsSelector, storesSelector } from './selectors';
import { makeItemSingle } from './store/d2-item-factory';

let awaCache: {
  [key: number]: AwaAuthorizationResult & { used: number };
};

export function canInsertPlug(
  socket: DimSocket,
  plugItemHash: number,
  destiny2CoreSettings: Destiny2CoreSettings,
  defs: D2ManifestDefinitions
) {
  return $featureFlags.awa || canInsertForFree(socket, plugItemHash, destiny2CoreSettings, defs);
}

function hasInsertionCost(defs: D2ManifestDefinitions, plug: DestinyInventoryItemDefinition) {
  if (plug.plug?.insertionMaterialRequirementHash) {
    const requirements = defs.MaterialRequirementSet.get(
      plug.plug?.insertionMaterialRequirementHash
    );
    // There are some items that explicitly point to a definition that says it costs 0 glimmer:
    return requirements.materials.some((m) => m.count !== 0);
  }
  return false;
}

function canInsertForFree(
  socket: DimSocket,
  plugItemHash: number,
  destiny2CoreSettings: Destiny2CoreSettings,
  defs: D2ManifestDefinitions
) {
  const { insertPlugFreeProtectedPlugItemHashes, insertPlugFreeBlockedSocketTypeHashes } =
    destiny2CoreSettings;
  if (
    (insertPlugFreeProtectedPlugItemHashes || []).includes(plugItemHash) ||
    (insertPlugFreeBlockedSocketTypeHashes || []).includes(socket.socketDefinition.socketTypeHash)
  ) {
    return false;
  }

  const plug = defs.InventoryItem.get(plugItemHash);

  const free =
    // Must be reusable or randomized type
    Boolean(
      socket.socketDefinition.reusablePlugItems.length > 0 ||
        socket.socketDefinition.reusablePlugSetHash ||
        socket.socketDefinition.randomizedPlugSetHash
    ) &&
    // And have no cost to insert
    !hasInsertionCost(defs, plug) &&
    // And the current plug didn't cost anything (can't replace a non-free mod with a free one)
    (!socket.plugged || !hasInsertionCost(defs, socket.plugged.plugDef));

  return free;
}

/**
 * Modify an item to insert a new plug into one of its socket.
 */
export function insertPlug(item: DimItem, socket: DimSocket, plugItemHash: number): ThunkResult {
  return async (dispatch, getState) => {
    const account = currentAccountSelector(getState())!;
    const defs = d2ManifestSelector(getState())!;
    const coreSettings = getState().manifest.destiny2CoreSettings!;

    // This is a special case for transmog ornaments - you can't apply a
    // transmog ornament to the same item it was created with. So instead we
    // swap at the last minute to applying the default ornament which should
    // match the appearance that the user wanted.
    if (plugItemHash === item.hash) {
      const defaultPlugHash = getDefaultPlugHash(socket, defs);
      plugItemHash = defaultPlugHash ?? plugItemHash;
    }

    const free = canInsertForFree(socket, plugItemHash, coreSettings, defs);

    // TODO: if applying to the vault, choose a character that has the mod unlocked rather than current store
    // look at all plugsets on all characters to find one that's unlocked?
    // memoize that index probably

    // TODO: if applying a mod with a seasonal variant, use the seasonal variant instead (may need d2ai power)

    // The API requires either the ID of the character that owns the item, or
    // the current character ID if the item is in the vault.
    const storeId = item.owner === 'vault' ? currentStoreSelector(getState())!.id : item.owner;

    const insertFn = free ? awaInsertSocketPlugFree : awaInsertSocketPlug;
    const response = await insertFn(account, storeId, item, socket, plugItemHash);

    // Update items that changed
    await dispatch(refreshItemAfterAWA(response.Response));
  };
}

/** basically just the DIM version of api-ts' `insertSocketPlugFree` */
async function awaInsertSocketPlugFree(
  account: DestinyAccount,
  storeId: string,
  item: DimItem,
  socket: DimSocket,
  plugItemHash: number
) {
  return insertSocketPlugFree(authenticatedHttpClient, {
    itemId: item.id,
    plug: {
      socketIndex: socket.socketIndex,
      socketArrayType: DestinySocketArrayType.Default,
      plugItemHash,
    },
    characterId: storeId,
    membershipType: account.originalPlatformType,
  });
}

/**
 * DIM's wrapper around insertSocketPlug, the actual paid
 * insertion endpoint that gets user push approval
 */
async function awaInsertSocketPlug(
  account: DestinyAccount,
  storeId: string,
  item: DimItem,
  socket: DimSocket,
  plugItemHash: number
) {
  if (!$featureFlags.awa) {
    throw new Error('AWA.NotSupported');
  }

  const actionToken = await getAwaToken(account, AwaType.InsertPlugs, storeId, item);

  // TODO: if the plug costs resources to insert, add a confirmation. This
  // would be a great place for a dialog component?

  return insertSocketPlug(authenticatedHttpClient, {
    actionToken,
    itemInstanceId: item.id,
    plug: {
      socketIndex: socket.socketIndex,
      socketArrayType: DestinySocketArrayType.Default,
      plugItemHash,
    },
    characterId: storeId,
    membershipType: account.originalPlatformType,
  });
}

/**
 * Update our view of the item based on the new item state Bungie returned.
 */
function refreshItemAfterAWA(changes: DestinyItemChangeResponse): ThunkResult {
  return async (dispatch, getState) => {
    const defs = d2ManifestSelector(getState())!;
    const buckets = d2BucketsSelector(getState())!;
    const stores = storesSelector(getState());
    const mergedCollectibles = mergedCollectiblesSelector(getState());
    const newItem = makeItemSingle(defs, buckets, changes.item, stores, mergedCollectibles);

    dispatch(
      awaItemChanged({
        item: newItem,
        changes,
        defs: d2ManifestSelector(getState())!,
        buckets: d2BucketsSelector(getState())!,
      })
    );
  };
}

/**
 * Given a request for an action token, and a particular action type, return either
 * a cached token or fetch and return a new one.
 *
 * Note: Error/success messaging must be handled by callers, but this will pop up a prompt to go to the app and grant permissions.
 *
 * @param item The item is optional unless the type is DismantleGroupA, but it's best to pass it when possible.
 */
export async function getAwaToken(
  account: DestinyAccount,
  action: AwaType,
  storeId: string,
  item?: DimItem
): Promise<string> {
  if (!awaCache) {
    // load from cache first time
    // TODO: maybe put this in Redux!
    awaCache = (await get('awa-tokens')) || {};
  }

  let info = awaCache[action];
  if (!info || !tokenValid(info)) {
    try {
      // Note: Error messages should be handled by other components. This is just to tell them to check the app.
      showNotification({
        type: 'info',
        title: t('AWA.ConfirmTitle'),
        body: t('AWA.ConfirmDescription'),
      });

      // TODO: Do we need to cache a token per item?
      info = awaCache[action] = {
        ...(await requestAdvancedWriteActionToken(account, action, storeId, item)),
        used: 0,
      };

      // Deletes of "group A" require an item and shouldn't be cached
      // TODO: This got removed from the API
      /*
      if (action === AwaType.DismantleGroupA) {
        delete awaCache[action]; // don't cache
      }
      */
    } catch (e) {
      throw new DimError('AWA.FailedToken').withError(e);

      // TODO: handle userSelection, responseReason (TimedOut, Replaced)
    }

    if (!info || !tokenValid(info)) {
      throw new DimError('AWA.FailedToken', info ? info.developerNote : 'no response');
    }
  }

  info.used++;

  // TODO: really should use a separate db for this
  await set('awa-tokens', awaCache);

  return info.actionToken;
}

function tokenValid(info: AwaAuthorizationResult & { used: number }) {
  return (
    (!info.validUntil || new Date(info.validUntil) > new Date()) &&
    (info.maximumNumberOfUses === 0 || info.used <= info.maximumNumberOfUses) &&
    info.userSelection === AwaUserSelection.Approved
  );
}
