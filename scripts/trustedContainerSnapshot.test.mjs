import assert from "node:assert/strict";
import test from "node:test";
import {
  trustedContainerSnapshotDigest,
} from "./trustedContainerSnapshot.mjs";

const REVISION = "a".repeat(40);

test("container snapshot ignores nested map and unordered set iteration order", () => {
  const first = fixture();
  const second = fixture();
  second.Config.Labels = {
    zeta: second.Config.Labels.zeta,
    "org.opencontainers.image.revision": REVISION,
    alpha: second.Config.Labels.alpha,
  };
  second.Mounts.reverse();
  second.NetworkSettings.Networks = {
    secondary: reorderedNetwork(second.NetworkSettings.Networks.secondary),
    primary: reorderedNetwork(second.NetworkSettings.Networks.primary),
  };
  second.NetworkSettings.Networks.primary.Aliases.reverse();
  second.NetworkSettings.Networks.primary.DNSNames.reverse();
  second.NetworkSettings.Networks.primary.Links.reverse();
  second.NetworkSettings.Networks.primary.IPAMConfig.LinkLocalIPs.reverse();

  assert.equal(
    trustedContainerSnapshotDigest([first]),
    trustedContainerSnapshotDigest([second]),
  );
});

test("container snapshot detects every frozen container identity and runtime change", () => {
  const original = fixture();
  const baseline = trustedContainerSnapshotDigest([original]);
  const mutations = [
    (item) => { item.Id = `b${item.Id.slice(1)}`; },
    (item) => { item.Image = `sha256:${"c".repeat(64)}`; },
    (item) => {
      item.Config.Labels["org.opencontainers.image.revision"] = "b".repeat(40);
    },
    (item) => { item.State.Health.Status = "unhealthy"; },
    (item) => { item.RestartCount = 1; },
    (item) => { item.Mounts[0].Source = "/var/lib/docker/volumes/changed/_data"; },
    (item) => { item.Mounts.pop(); },
    (item) => { item.NetworkSettings.Networks.primary.IPAddress = "172.20.0.99"; },
    (item) => { delete item.NetworkSettings.Networks.secondary; },
    (item) => { item.NetworkSettings.Networks.primary.Aliases.push("changed-alias"); },
  ];

  for (const mutate of mutations) {
    const changed = fixture();
    mutate(changed);
    assert.notEqual(trustedContainerSnapshotDigest([changed]), baseline);
  }

  assert.notEqual(
    trustedContainerSnapshotDigest([original, { ...fixture(), Id: `d${original.Id.slice(1)}` }]),
    baseline,
  );
  assert.notEqual(trustedContainerSnapshotDigest([]), baseline);
});

function fixture() {
  return {
    Id: `a${"1".repeat(63)}`,
    Image: `sha256:${"b".repeat(64)}`,
    Name: "/xingheng-api-1",
    Config: {
      Labels: {
        alpha: "one",
        "org.opencontainers.image.revision": REVISION,
        zeta: "two",
      },
    },
    HostConfig: { NetworkMode: "xingheng_default" },
    State: {
      Running: true,
      Status: "running",
      Health: { Status: "healthy" },
    },
    RestartCount: 0,
    Mounts: [
      {
        Type: "volume",
        Name: "xingheng_sqlite_data",
        Source: "/var/lib/docker/volumes/xingheng_sqlite_data/_data",
        Destination: "/app/data",
        Driver: "local",
        Mode: "rw",
        RW: true,
        Propagation: "",
      },
      {
        Type: "bind",
        Source: "/run/xingheng/gcp-wif",
        Destination: "/run/secrets/gcp-wif",
        Mode: "ro",
        RW: false,
        Propagation: "rprivate",
      },
    ],
    NetworkSettings: {
      Networks: {
        primary: network("endpoint-primary", "172.20.0.2"),
        secondary: network("endpoint-secondary", "172.21.0.2"),
      },
    },
  };
}

function network(endpointId, ipAddress) {
  return {
    NetworkID: `network-${endpointId}`,
    EndpointID: endpointId,
    Gateway: "172.20.0.1",
    IPAddress: ipAddress,
    IPPrefixLen: 16,
    IPv6Gateway: "",
    GlobalIPv6Address: "",
    GlobalIPv6PrefixLen: 0,
    MacAddress: "02:42:ac:14:00:02",
    GwPriority: 0,
    Aliases: ["xingheng-api-1", "api"],
    DNSNames: ["api", "xingheng-api-1"],
    Links: ["legacy:api", "legacy:api-alias"],
    DriverOpts: { zeta: "two", alpha: "one" },
    IPAMConfig: {
      IPv4Address: "",
      IPv6Address: "",
      LinkLocalIPs: ["169.254.1.2", "169.254.1.1"],
    },
  };
}

function reorderedNetwork(source) {
  return {
    IPAMConfig: {
      LinkLocalIPs: [...source.IPAMConfig.LinkLocalIPs],
      IPv6Address: source.IPAMConfig.IPv6Address,
      IPv4Address: source.IPAMConfig.IPv4Address,
    },
    DriverOpts: {
      alpha: source.DriverOpts.alpha,
      zeta: source.DriverOpts.zeta,
    },
    Links: [...source.Links],
    DNSNames: [...source.DNSNames],
    Aliases: [...source.Aliases],
    GwPriority: source.GwPriority,
    MacAddress: source.MacAddress,
    GlobalIPv6PrefixLen: source.GlobalIPv6PrefixLen,
    GlobalIPv6Address: source.GlobalIPv6Address,
    IPv6Gateway: source.IPv6Gateway,
    IPPrefixLen: source.IPPrefixLen,
    IPAddress: source.IPAddress,
    Gateway: source.Gateway,
    EndpointID: source.EndpointID,
    NetworkID: source.NetworkID,
  };
}
