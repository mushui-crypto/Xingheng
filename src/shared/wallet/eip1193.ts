export type Eip1193Provider = {
  isMetaMask?: boolean;
  request: (payload: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: "accountsChanged" | "chainChanged", listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: "accountsChanged" | "chainChanged", listener: (...args: unknown[]) => void) => void;
};

type Eip6963ProviderDetail = {
  info: {
    uuid: string;
    name: string;
    icon: string;
    rdns: string;
  };
  provider: Eip1193Provider;
};

type AnnouncedProvider = {
  provider: Eip1193Provider;
  name?: string;
  rdns?: string;
  legacy: boolean;
};

const announceEventName = "eip6963:announceProvider";
const requestEventName = "eip6963:requestProvider";

export async function discoverInjectedEthereumProvider(timeoutMs = 300): Promise<Eip1193Provider | null> {
  if (typeof window === "undefined") {
    return null;
  }

  const announced: AnnouncedProvider[] = [];
  const addProvider = (provider: Eip1193Provider | undefined, options: { name?: string; rdns?: string; legacy?: boolean } = {}) => {
    if (provider?.request && !announced.some((item) => item.provider === provider)) {
      announced.push({ provider, name: options.name, rdns: options.rdns, legacy: options.legacy ?? false });
    }
  };
  const handleAnnouncement = (event: Event) => {
    const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
    if (detail?.provider) {
      addProvider(detail.provider, { name: detail.info?.name, rdns: detail.info?.rdns });
    }
  };

  window.addEventListener(announceEventName, handleAnnouncement);
  window.dispatchEvent(new Event(requestEventName));

  await new Promise<void>((resolve) => window.setTimeout(resolve, Math.max(0, timeoutMs)));
  window.removeEventListener(announceEventName, handleAnnouncement);

  const legacy = (window as Window & { ethereum?: Eip1193Provider & { providers?: Eip1193Provider[] } }).ethereum;
  legacy?.providers?.forEach((provider) => addProvider(provider, { legacy: true }));
  addProvider(legacy, { legacy: true });

  return selectPreferredProvider(announced);
}

function selectPreferredProvider(providers: AnnouncedProvider[]) {
  return providers.find((item) => item.rdns?.toLowerCase() === "io.metamask")?.provider
    ?? providers.find((item) => item.name?.trim().toLowerCase() === "metamask")?.provider
    ?? providers.find((item) => item.legacy && item.provider.isMetaMask)?.provider
    ?? providers[0]?.provider
    ?? null;
}
