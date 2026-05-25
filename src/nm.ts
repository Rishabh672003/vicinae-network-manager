import DBus from "dbus-next";
import type { WifiNetwork, SavedConnection, ActiveConnection, WifiDevice } from "./types";

const bus = DBus.systemBus();

const NM = "org.freedesktop.NetworkManager";
const NM_PATH = "/org/freedesktop/NetworkManager";
const NM_IFACE = "org.freedesktop.NetworkManager";
const NM_DEVICE_IFACE = "org.freedesktop.NetworkManager.Device";
const NM_WIRELESS_IFACE = "org.freedesktop.NetworkManager.Device.Wireless";
const NM_AP_IFACE = "org.freedesktop.NetworkManager.AccessPoint";
const NM_CONN_ACTIVE_IFACE = "org.freedesktop.NetworkManager.Connection.Active";
const NM_SETTINGS_IFACE = "org.freedesktop.NetworkManager.Settings";
const NM_SETTINGS_CONN = "org.freedesktop.NetworkManager.Settings.Connection";
const PROPS_IFACE = "org.freedesktop.DBus.Properties";

// ── Helpers ────────────────────────────────────────────────────────────────

async function getProps(objectPath: string, iface: string): Promise<Record<string, DBus.Variant>> {
    const obj = await bus.getProxyObject(NM, objectPath);
    const props = obj.getInterface(PROPS_IFACE);
    const all = await props.GetAll(iface);
    return all;
}

async function setProp(objectPath: string, iface: string, key: string, value: DBus.Variant) {
    const obj = await bus.getProxyObject(NM, objectPath);
    const props = obj.getInterface(PROPS_IFACE);
    await props.Set(iface, key, value);
}

function ssidBytesToString(ssidVariant: any): string {
    try {
        const bytes: number[] = Array.from(ssidVariant?.value ?? ssidVariant ?? []);
        return Buffer.from(bytes).toString("utf8");
    } catch {
        return "";
    }
}

// ── WiFi device ────────────────────────────────────────────────────────────

export async function getWifiDevice(): Promise<WifiDevice | null> {
    const obj = await bus.getProxyObject(NM, NM_PATH);
    const nm = obj.getInterface(NM_IFACE);
    const devicePaths: string[] = await nm.GetDevices();

    for (const path of devicePaths) {
        const props = await getProps(path, NM_DEVICE_IFACE);
        // DeviceType 2 = NM_DEVICE_TYPE_WIFI
        if (props.DeviceType?.value === 2) {
            const wProps = await getProps(path, NM_WIRELESS_IFACE);
            return {
                objectPath: path,
                iface: props.Interface?.value ?? "",
                activeAccessPointPath: wProps.ActiveAccessPoint?.value ?? null,
            };
        }
    }
    return null;
}

// ── Scanning ───────────────────────────────────────────────────────────────

export async function requestScan(devicePath: string) {
    const obj = await bus.getProxyObject(NM, devicePath);
    const wireless = obj.getInterface(NM_WIRELESS_IFACE);
    await wireless.RequestScan({});
}

export async function getAccessPoints(devicePath: string): Promise<WifiNetwork[]> {
    const obj = await bus.getProxyObject(NM, devicePath);
    const wireless = obj.getInterface(NM_WIRELESS_IFACE);
    const apPaths: string[] = await wireless.GetAllAccessPoints();

    const wDevice = await getProps(devicePath, NM_WIRELESS_IFACE);
    const activeAP = wDevice.ActiveAccessPoint?.value ?? null;

    const networks: WifiNetwork[] = [];

    for (const apPath of apPaths) {
        try {
            const props = await getProps(apPath, NM_AP_IFACE);
            const ssid = ssidBytesToString(props.Ssid);
            if (!ssid) continue; // skip hidden networks

            // Deduplicate by SSID — keep strongest signal
            const existing = networks.findIndex((n) => n.ssid === ssid);
            const strength = props.Strength?.value ?? 0;
            const flags = props.Flags?.value ?? 0;
            const wpaFlags = props.WpaFlags?.value ?? 0;
            const rsnFlags = props.RsnFlags?.value ?? 0;
            const secured = wpaFlags > 0 || rsnFlags > 0 || (flags & 0x1) > 0;

            const entry: WifiNetwork = {
                ssid,
                bssid: props.HwAddress?.value ?? "",
                strength,
                frequency: props.Frequency?.value ?? 0,
                secured,
                activeAccessPointPath: activeAP,
                objectPath: apPath,
            };

            if (existing === -1) {
                networks.push(entry);
            } else if (strength > networks[existing].strength) {
                networks[existing] = entry;
            }
        } catch {
            continue;
        }
    }

    return networks.sort((a, b) => b.strength - a.strength);
}

// ── Active connections ─────────────────────────────────────────────────────

export async function getActiveConnections(): Promise<ActiveConnection[]> {
    const nmProps = await getProps(NM_PATH, NM_IFACE);
    const paths: string[] = nmProps.ActiveConnections?.value ?? [];
    const result: ActiveConnection[] = [];

    for (const path of paths) {
        try {
            const props = await getProps(path, NM_CONN_ACTIVE_IFACE);
            // Type "802-11-wireless" means WiFi
            if (props.Type?.value !== "802-11-wireless") continue;

            // Try to get IPv4 address
            let ip4Address: string | null = null;
            try {
                const ip4Path = props.Ip4Config?.value;
                if (ip4Path && ip4Path !== "/") {
                    const ip4Props = await getProps(ip4Path, "org.freedesktop.NetworkManager.IP4Config");
                    const addrData = ip4Props.AddressData?.value;
                    ip4Address = addrData?.[0]?.address?.value ?? null;
                }
            } catch { /* no IP yet */ }

            result.push({
                id: props.Id?.value ?? "",
                uuid: props.Uuid?.value ?? "",
                ssid: props.Id?.value ?? "",
                state: props.State?.value ?? 0,
                objectPath: path,
                ip4Address,
            });
        } catch {
            continue;
        }
    }

    return result;
}

export async function disconnectNetwork(activeConnPath: string) {
    const obj = await bus.getProxyObject(NM, NM_PATH);
    const nm = obj.getInterface(NM_IFACE);
    await nm.DeactivateConnection(activeConnPath);
}

// ── Saved connections ──────────────────────────────────────────────────────

export async function getSavedConnections(): Promise<SavedConnection[]> {
    const obj = await bus.getProxyObject(NM, "/org/freedesktop/NetworkManager/Settings");
    const settings = obj.getInterface(NM_SETTINGS_IFACE);
    const paths: string[] = await settings.ListConnections();
    const result: SavedConnection[] = [];

    for (const path of paths) {
        try {
            const connObj = await bus.getProxyObject(NM, path);
            const connIface = connObj.getInterface(NM_SETTINGS_CONN);
            const raw = await connIface.GetSettings();

            const conn = raw["connection"] ?? {};
            const wireless = raw["802-11-wireless"] ?? {};
            const type = conn.type?.value ?? "";
            if (type !== "802-11-wireless") continue;

            const ssidRaw = wireless.ssid?.value;
            const ssid = ssidRaw ? ssidBytesToString(ssidRaw) : (conn.id?.value ?? "");

            result.push({
                id: conn.id?.value ?? "",
                uuid: conn.uuid?.value ?? "",
                ssid,
                autoconnect: conn.autoconnect?.value ?? true,
                objectPath: path,
            });
        } catch {
            continue;
        }
    }

    return result;
}

export async function forgetConnection(objectPath: string) {
    const obj = await bus.getProxyObject(NM, objectPath);
    const conn = obj.getInterface(NM_SETTINGS_CONN);
    await conn.Delete();
}

export async function renameConnection(objectPath: string, newId: string) {
    const obj = await bus.getProxyObject(NM, objectPath);
    const connIface = obj.getInterface(NM_SETTINGS_CONN);
    const raw = await connIface.GetSettings();
    raw["connection"]["id"] = new DBus.Variant("s", newId);
    await connIface.Update(raw);
}

export async function setAutoconnect(objectPath: string, autoconnect: boolean, raw?: any) {
    const obj = await bus.getProxyObject(NM, objectPath);
    const connIface = obj.getInterface(NM_SETTINGS_CONN);
    const settings = raw ?? await connIface.GetSettings();
    settings["connection"]["autoconnect"] = new DBus.Variant("b", autoconnect);
    await connIface.Update(settings);
}

// ── Connect ────────────────────────────────────────────────────────────────

/**
 * Connect to a known saved connection by UUID.
 */
export async function connectSaved(uuid: string, devicePath: string) {
    const saved = await getSavedConnections();
    const match = saved.find((c) => c.uuid === uuid);
    if (!match) throw new Error("Saved connection not found");

    const obj = await bus.getProxyObject(NM, NM_PATH);
    const nm = obj.getInterface(NM_IFACE);
    await nm.ActivateConnection(match.objectPath, devicePath, "/");
}

/**
 * Connect to a new (unsaved) network — prompts for password handled in UI.
 */
export async function connectNew(
    ssid: string,
    password: string | null,
    devicePath: string,
    apPath: string
) {
    const obj = await bus.getProxyObject(NM, NM_PATH);
    const nm = obj.getInterface(NM_IFACE);

    const connection: Record<string, Record<string, DBus.Variant>> = {
        "connection": {
            "id": new DBus.Variant("s", ssid),
            "type": new DBus.Variant("s", "802-11-wireless"),
        },
        "802-11-wireless": {
            "ssid": new DBus.Variant("ay", Buffer.from(ssid)),
            "mode": new DBus.Variant("s", "infrastructure"),
        },
    };

    if (password) {
        connection["802-11-wireless-security"] = {
            "key-mgmt": new DBus.Variant("s", "wpa-psk"),
            "psk": new DBus.Variant("s", password),
        };
        connection["802-11-wireless"]["security"] = new DBus.Variant("s", "802-11-wireless-security");
    }

    await nm.AddAndActivateConnection(connection, devicePath, apPath);
}

export function closeBus() {
    bus.disconnect();
}