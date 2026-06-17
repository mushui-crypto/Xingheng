import { create } from "zustand";
import type { PlatformConfig } from "../types";
import { readStorage, storageKeys, writeStorage } from "../utils/storage";

export const defaultPlatformConfig: PlatformConfig = {
  platformName: "TradeSim Pro",
  logoText: "TSP",
  themeColor: "#00C896",
  defaultCurrency: "USD",
  riskNotice:
    "本平台当前为模拟交易环境，所有交易均为虚拟成交，不涉及真实资金交易。",
};

type ConfigStore = {
  config: PlatformConfig;
  updateConfig: (config: PlatformConfig) => void;
  resetConfig: () => void;
};

export const useConfigStore = create<ConfigStore>((set) => ({
  config: readStorage<PlatformConfig>(storageKeys.config, defaultPlatformConfig),
  updateConfig: (config) => {
    writeStorage(storageKeys.config, config);
    set({ config });
  },
  resetConfig: () => {
    writeStorage(storageKeys.config, defaultPlatformConfig);
    set({ config: defaultPlatformConfig });
  },
}));
