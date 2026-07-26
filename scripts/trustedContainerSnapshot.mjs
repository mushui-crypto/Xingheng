import { createHash } from "node:crypto";

const OCI_REVISION_LABEL = "org.opencontainers.image.revision";

export function trustedContainerSnapshotDigest(inspectedContainers) {
  return sha256Json(normalizeInspectedContainers(inspectedContainers));
}

export function normalizeInspectedContainers(inspectedContainers) {
  if (!Array.isArray(inspectedContainers)) {
    throw new Error("trusted container inspect result must be an array");
  }
  return inspectedContainers
    .map((item) => ({
      id: item.Id,
      image: item.Image,
      revision: item.Config?.Labels?.[OCI_REVISION_LABEL] ?? null,
      labels: item.Config?.Labels ?? {},
      mounts: normalizeMountSet(item.Mounts ?? []),
      name: item.Name,
      networkMode: item.HostConfig?.NetworkMode,
      networks: normalizeNetworkSet(item.NetworkSettings?.Networks ?? {}),
      restartCount: item.RestartCount,
      running: item.State?.Running,
      status: item.State?.Status,
      health: item.State?.Health?.Status ?? null,
    }))
    .sort((left, right) => compareStrings(left.id, right.id));
}

function normalizeMountSet(mounts) {
  return mounts
    .map((mount) => ({
      type: mount.Type ?? null,
      name: mount.Name ?? null,
      source: mount.Source ?? null,
      destination: mount.Destination ?? null,
      driver: mount.Driver ?? null,
      mode: mount.Mode ?? null,
      readWrite: mount.RW ?? null,
      propagation: mount.Propagation ?? null,
    }))
    .sort(compareCanonicalValues);
}

function normalizeNetworkSet(networks) {
  return Object.entries(networks)
    .map(([name, network]) => ({
      name,
      networkId: network.NetworkID ?? null,
      endpointId: network.EndpointID ?? null,
      gateway: network.Gateway ?? null,
      ipAddress: network.IPAddress ?? null,
      ipPrefixLength: network.IPPrefixLen ?? null,
      ipv6Gateway: network.IPv6Gateway ?? null,
      globalIpv6Address: network.GlobalIPv6Address ?? null,
      globalIpv6PrefixLength: network.GlobalIPv6PrefixLen ?? null,
      macAddress: network.MacAddress ?? null,
      gatewayPriority: network.GwPriority ?? null,
      aliases: normalizeStringSet(network.Aliases),
      dnsNames: normalizeStringSet(network.DNSNames),
      links: normalizeStringSet(network.Links),
      driverOptions: network.DriverOpts ?? null,
      ipamConfig: normalizeIpamConfig(network.IPAMConfig),
    }))
    .sort((left, right) => compareStrings(left.name, right.name));
}

function normalizeIpamConfig(config) {
  if (config === null || config === undefined) return null;
  return {
    ipv4Address: config.IPv4Address ?? null,
    ipv6Address: config.IPv6Address ?? null,
    linkLocalIps: normalizeStringSet(config.LinkLocalIPs),
  };
}

function normalizeStringSet(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("trusted container inspect set must contain strings");
  }
  return [...value].sort(compareStrings);
}

function compareCanonicalValues(left, right) {
  return compareStrings(stableJson(left), stableJson(right));
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sha256Json(value) {
  return createHash("sha256").update(`${stableJson(value)}\n`).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
