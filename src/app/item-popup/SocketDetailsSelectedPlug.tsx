import { D2ManifestDefinitions } from 'app/destiny2/d2-definitions';
import BungieImage from 'app/dim-ui/BungieImage';
import { t } from 'app/i18next-t';
import { canInsertPlug, insertPlug } from 'app/inventory/advanced-write-actions';
import {
  DimItem,
  DimPlug,
  DimSocket,
  DimStat,
  PluggableInventoryItemDefinition,
} from 'app/inventory/item-types';
import { interpolateStatValue } from 'app/inventory/store/stats';
import { destiny2CoreSettingsSelector, useD2Definitions } from 'app/manifest/selectors';
import { showNotification } from 'app/notifications/notifications';
import { DEFAULT_ORNAMENTS } from 'app/search/d2-known-values';
import { refreshIcon } from 'app/shell/icons';
import AppIcon from 'app/shell/icons/AppIcon';
import { useThunkDispatch } from 'app/store/thunk-dispatch';
import {
  emptySpecialtySocketHashes,
  isPlugStatActive,
  itemIsInstanced,
} from 'app/utils/item-utils';
import { DestinyItemSocketEntryDefinition } from 'bungie-api-ts/destiny2';
import clsx from 'clsx';
import { PlugCategoryHashes, SocketCategoryHashes, StatHashes } from 'data/d2/generated-enums';
import { motion } from 'framer-motion';
import _ from 'lodash';
import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import ItemStats from './ItemStats';
import { StatValue } from './PlugTooltip';
import { SocketDetailsMod } from './SocketDetails';
import styles from './SocketDetailsSelectedPlug.m.scss';

const costStatHashes = [
  StatHashes.AnyEnergyTypeCost,
  StatHashes.VoidCost,
  StatHashes.SolarCost,
  StatHashes.ArcCost,
];

const whitelistPlugCategoryToLocKey = {
  [PlugCategoryHashes.Shader]: 'Shader',
  [PlugCategoryHashes.ShipSpawnfx]: 'Transmat',
  [PlugCategoryHashes.Hologram]: 'Projection',
};

const socketCategoryToLocKey = {
  [SocketCategoryHashes.Abilities]: 'Ability',
  [SocketCategoryHashes.Aspects]: 'Aspect',
  [SocketCategoryHashes.Fragments]: 'Fragment',
};

/** Figures out what kind of socket this is so that the "Apply" button can name the correct thing
 * instead of generically saying "Select/Insert Mod".
 * Note that these are used as part of the localization key.
 */
function uiCategorizeSocket(defs: D2ManifestDefinitions, socket: DestinyItemSocketEntryDefinition) {
  const socketTypeDef = socket.socketTypeHash && defs.SocketType.get(socket.socketTypeHash);
  if (socketTypeDef) {
    if (socketCategoryToLocKey[socketTypeDef.socketCategoryHash]) {
      return socketCategoryToLocKey[socketTypeDef.socketCategoryHash];
    } else {
      const plug = socketTypeDef.plugWhitelist.find(
        (p) => whitelistPlugCategoryToLocKey[p.categoryHash]
      );
      if (plug) {
        return whitelistPlugCategoryToLocKey[plug.categoryHash];
      }
    }
  }

  const initialPlugHash = socket.singleInitialItemHash;
  if (initialPlugHash && DEFAULT_ORNAMENTS.includes(initialPlugHash)) {
    return 'Ornament';
  }

  return 'Mod';
}

export default function SocketDetailsSelectedPlug({
  plug,
  socket,
  item,
  currentPlug,
  equippable,
  allowInsertPlug,
  closeMenu,
  onPlugSelected,
}: {
  plug: PluggableInventoryItemDefinition;
  socket: DimSocket;
  item: DimItem;
  currentPlug: DimPlug | null;
  equippable: boolean;
  allowInsertPlug: boolean;
  closeMenu(): void;
  /** If this is set, instead of offering to slot the mod, we just notify above */
  onPlugSelected?(value: { item: DimItem; socket: DimSocket; plugHash: number }): void;
}) {
  const dispatch = useThunkDispatch();
  const defs = useD2Definitions()!;
  const destiny2CoreSettings = useSelector(destiny2CoreSettingsSelector)!;
  const selectedPlugPerk =
    Boolean(plug.perks?.length) && defs.SandboxPerk.get(plug.perks[0].perkHash);

  const materialRequirementSet =
    (plug.plug.insertionMaterialRequirementHash &&
      defs.MaterialRequirementSet.get(plug.plug.insertionMaterialRequirementHash)) ||
    undefined;

  const sourceString =
    plug.collectibleHash && defs.Collectible.get(plug.collectibleHash)?.sourceString;

  const stats = _.compact(
    plug.investmentStats.map((stat) => {
      if (costStatHashes.includes(stat.statTypeHash)) {
        return null;
      }
      const itemStat = item.stats?.find((s) => s.statHash === stat.statTypeHash);
      if (!itemStat) {
        return null;
      }
      const statGroupDef = defs.StatGroup.get(
        defs.InventoryItem.get(item.hash).stats!.statGroupHash!
      );

      const statDisplay = statGroupDef?.scaledStats.find((s) => s.statHash === stat.statTypeHash);

      const currentModValue = currentPlug?.stats?.[stat.statTypeHash] || 0;

      if (!isPlugStatActive(item, plug.hash, stat.statTypeHash, stat.isConditionallyActive)) {
        return null;
      }
      let modValue = stat.value;
      const updatedInvestmentValue = itemStat.investmentValue + modValue - currentModValue;
      let itemStatValue = updatedInvestmentValue;

      if (statDisplay) {
        itemStatValue = interpolateStatValue(updatedInvestmentValue, statDisplay);
        modValue =
          itemStatValue - interpolateStatValue(updatedInvestmentValue - modValue, statDisplay);
      }

      return {
        modValue,
        dimStat: {
          ...itemStat,
          value: itemStatValue,
        } as DimStat,
      };
    })
  );

  // Can we actually insert this mod instead of just previewing it?
  const canDoAWA =
    allowInsertPlug &&
    itemIsInstanced(item) &&
    canInsertPlug(socket, plug.hash, destiny2CoreSettings, defs);

  const kind = uiCategorizeSocket(defs, socket.socketDefinition);
  const insertName = canDoAWA
    ? t(`Sockets.Insert.${kind}`, { contextList: 'sockets' })
    : t(`Sockets.Select.${kind}`, { contextList: 'sockets' });

  const [insertInProgress, setInsertInProgress] = useState(false);

  // TODO: Push the insertPlug stuff all the way up and out of SocketDetails
  const onInsertPlug = async () => {
    if (canDoAWA) {
      setInsertInProgress(true);
      try {
        await dispatch(insertPlug(item, socket, plug.hash));
        closeMenu();
      } catch (e) {
        const plugName = plug.displayProperties.name ?? 'Unknown Plug';
        showNotification({
          type: 'error',
          title: t('AWA.Error'),
          body: t('AWA.ErrorMessage', { error: e.message, item: item.name, plug: plugName }),
        });
      } finally {
        setInsertInProgress(false);
      }
    } else {
      onPlugSelected?.({ item, socket, plugHash: plug.hash });
      closeMenu();
    }
  };

  const costs = materialRequirementSet?.materials.map((material) => {
    const materialDef = defs.InventoryItem.get(material.itemHash);
    return (
      materialDef &&
      material.count > 0 &&
      !material.omitFromRequirements && (
        <div className={styles.material} key={material.itemHash}>
          {material.count.toLocaleString()}
          <BungieImage
            src={materialDef.displayProperties.icon}
            title={materialDef.displayProperties.name}
          />
        </div>
      )
    );
  });

  return (
    <div className={clsx(styles.selectedPlug, { [styles.hasStats]: stats.length > 0 })}>
      <div className={styles.modIcon}>
        <SocketDetailsMod itemDef={plug} />
      </div>
      <div className={styles.modDescription}>
        <h3>
          {plug.displayProperties.name}
          {emptySpecialtySocketHashes.includes(plug.hash) && (
            <> &mdash; {plug.itemTypeDisplayName}</>
          )}
        </h3>
        {selectedPlugPerk ? (
          <div>{selectedPlugPerk.displayProperties.description}</div>
        ) : (
          plug.displayProperties.description && <div>{plug.displayProperties.description}</div>
        )}
        {sourceString && <div>{sourceString}</div>}
      </div>
      {stats.length > 0 && (
        <div className={styles.modStats}>
          {stats.map((stat) => (
            <div className="plug-stats" key={stat.dimStat.statHash}>
              <StatValue value={stat.modValue} statHash={stat.dimStat.statHash} />
            </div>
          ))}
        </div>
      )}
      {stats.length > 0 && (
        <ItemStats stats={stats.map((s) => s.dimStat)} className={styles.itemStats} />
      )}
      {(canDoAWA || onPlugSelected) && (
        <motion.button
          layout
          type="button"
          className={styles.insertButton}
          onClick={onInsertPlug}
          disabled={(canDoAWA && !equippable) || insertInProgress}
        >
          {insertInProgress && (
            <motion.span layout>
              <AppIcon icon={refreshIcon} spinning={true} />
            </motion.span>
          )}
          <motion.span layout className={styles.insertLabel}>
            <motion.span layout>{insertName}</motion.span>
            <motion.span layout>{costs}</motion.span>
          </motion.span>
        </motion.button>
      )}
    </div>
  );
}
