/**
 * @fileoverview Queries the blockchain to fetch all available data of a
 *    quest based on quest id.
 */

const { ethers } = require('ethers');

const {
  getHeroesChain,
} = require('../heroes-fetch/fetch-heroes-blockchain.ent');
const { unixToJsDate } = require('../utils/helpers');
const { getProvider, getQuestCoreV1, getQuestCoreV2 } = require('../ether');
const {
  QUEST_CORE_V2_CONTRACT,
  QUESTS_REV,
  QUEST_GARDENING,
} = require('../constants/addresses.const');
const {
  QUEST_CORE_V2_TOPIC_QuestStarted,
} = require('../constants/topics.const');
const abiQuestCoreV2 = require('../abi/quest-core-v2.abi.json');
const { heroQuestStr } = require('../heroes-helpers/hero-to-string.ent');
const { PoolsIndexedByPid } = require('../constants/garden-pools.const');

/**
 * Queries the blockchain to fetch all available data of a
 *    quest based on quest id.
 *
 * @param {number} questId THe quest id.
 * @return {Promise<Object>} Processed and normalized quest data.
 */
exports.queryQuest = async (questId) => {
  const questData = await exports.fetchQuestData(questId);
  await exports.getQuestHeroData(questData);
  await exports.getGardeningData(questData);

  return questData;
};

/**
 * Will fetch raw Quest data regardless of QuestCore version.
 *
 * @param {number} questId The quest id to fetch.
 * @return {Promise<Object>} Normalized quest data.
 */
exports.fetchQuestData = async (questId) => {
  const currentRPC = await getProvider();

  const questsV1Contract = getQuestCoreV1(currentRPC);
  const questsV2Contract = getQuestCoreV2(currentRPC);

  const [resV1, resV2] = await Promise.allSettled([
    questsV1Contract.getQuest(questId),
    questsV2Contract.quests(questId),
  ]);

  let rawQuestDataV1 = {};
  let rawQuestDataV2 = {};
  if (resV1.status === 'fulfilled') {
    rawQuestDataV1 = resV1.value;
  }
  if (resV2.status === 'fulfilled') {
    rawQuestDataV2 = resV2.value;
  }

  const questIdV2 = Number(rawQuestDataV2.id);

  let questData = {};
  if (questIdV2) {
    questData = exports.normalizeQuestV2(rawQuestDataV2);
  } else {
    questData = exports.normalizeQuestV1(rawQuestDataV1);
  }

  return questData;
};

/**
 * Normalizes chain Quest V1 data.
 *
 * @param {Object} rawQuestDataV1 The raw response from the chain.
 * @return {Object} Normalized quest data.
 */
exports.normalizeQuestV1 = (rawQuestDataV1) => {
  const questData = {
    version: 1,
    id: Number(rawQuestDataV1.id),
    questAddress: rawQuestDataV1.quest,
    questAddressLower: rawQuestDataV1.quest.toLowerCase(),
    playerAddress: rawQuestDataV1.player,
    playerAddressLower: rawQuestDataV1.player.toLowerCase(),

    startBlock: unixToJsDate(rawQuestDataV1.startBlock),
    startAtTime: unixToJsDate(rawQuestDataV1.startTime),
    completeAtTime: unixToJsDate(rawQuestDataV1.completeAtTime),
    attempts: rawQuestDataV1.attempts,
    status: rawQuestDataV1.status,

    // Only V1
    heroIds: rawQuestDataV1.heroes.map((heroId) => Number(heroId)),
  };

  questData.questName = QUESTS_REV[questData.questAddressLower];

  return questData;
};

/**
 * Normalizes chain Quest V2 data.
 *
 * @param {Object} rawQuestDataV2 The raw response from the chain.
 * @return {Object} Normalized quest data.
 */
exports.normalizeQuestV2 = (rawQuestDataV2) => {
  const questData = {
    version: 2,

    id: Number(rawQuestDataV2.id),
    questAddress: rawQuestDataV2.questAddress,
    questAddressLower: rawQuestDataV2.questAddress.toLowerCase(),
    playerAddress: rawQuestDataV2.player,
    playerAddressLower: rawQuestDataV2.player.toLowerCase(),

    startBlock: Number(rawQuestDataV2.startBlock),
    startAtTime: unixToJsDate(rawQuestDataV2.startAtTime),
    completeAtTime: unixToJsDate(rawQuestDataV2.completeAtTime),
    attempts: rawQuestDataV2.attempts,
    status: rawQuestDataV2.status,

    // Only V2
    level: rawQuestDataV2.level,
  };

  questData.questName = QUESTS_REV[questData.questAddressLower];

  return questData;
};

/**
 * Will fetch and augment the questData input object with heroes data.
 *
 * Will populate:
 *    - allHeroes: Array of full hero objects.
 *    - heroesStr: Quest string rendering of heroes.
 *
 * @param {Object} questData Normnalized Quest data.
 * @return {Promise<void>} Augments questData object.
 */
exports.getQuestHeroData = async (questData) => {
  if (questData.version === 2) {
    await exports.getQuestV2QuestHeroes(questData);
  }

  const { heroIds } = questData;

  const heroes = await getHeroesChain(heroIds);

  questData.allHeroes = heroes;
  const allHeroesStr = heroes.map(heroQuestStr);
  questData.heroesQuestStr = allHeroesStr.join(', ');
};

/**
 * Will query the chain for the questStart event and find the heroes
 * used on this quest.
 *
 * @param {Object} questData Normnalized Quest data.
 * @return {Promise<void>} Augments questData object.
 */
exports.getQuestV2QuestHeroes = async (questData) => {
  questData.heroIds = [];
  const currentRPC = await getProvider();
  const { provider } = currentRPC;

  // Prepare the filtering arguments of the getLog query
  const getLogsOpts = {
    address: QUEST_CORE_V2_CONTRACT,
    fromBlock: questData.startBlock,
    toBlock: questData.startBlock,
    topics: [QUEST_CORE_V2_TOPIC_QuestStarted],
  };

  // Perform the getLog query
  const encodedEventLogs = await provider.getLogs(getLogsOpts);

  // Find the one event log that contains the heroes
  const iface = new ethers.utils.Interface(abiQuestCoreV2);
  const [eventQuestStarted] = encodedEventLogs.filter((logItem) => {
    const decoded = iface.decodeEventLog('QuestStarted', logItem.data);
    return decoded.quest.player !== questData.playerAddress;
  });

  if (!eventQuestStarted) {
    return;
  }

  const decoded = iface.decodeEventLog('QuestStarted', eventQuestStarted.data);

  questData.heroIds = decoded.quest.heroes.map((heroId) => Number(heroId));
};

/**
 * Will augment the questData with gardning info, if the quest is gardening.
 *
 * @param {Object} questData Normnalized Quest data.
 * @return {Promise<void>} Augments questData object.
 */
exports.getGardeningData = async (questData) => {
  if (questData.questAddressLower !== QUEST_GARDENING) {
    return;
  }

  const currentRPC = await getProvider();
  const questsV1Contract = getQuestCoreV1(currentRPC);

  const gardeningInfo = await questsV1Contract.getQuestData(questData.id);

  const gardenPoolId = Number(gardeningInfo.uint1);
  questData.gardenPool = PoolsIndexedByPid[gardenPoolId];
};