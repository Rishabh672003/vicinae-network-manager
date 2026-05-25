export interface WifiNetwork {
    ssid: string;
    bssid: string;
    strength: number;        // 0–100
    frequency: number;       // MHz
    secured: boolean;
    activeAccessPointPath: string | null;
    objectPath: string;      // AP D-Bus path
}

export interface SavedConnection {
    id: string;              // user-facing name
    uuid: string;
    ssid: string;
    autoconnect: boolean;
    objectPath: string;      // Settings.Connection path
}

export interface ActiveConnection {
    id: string;
    uuid: string;
    ssid: string;
    state: number;           // NM active connection state
    objectPath: string;
    ip4Address: string | null;
}

export interface WifiDevice {
    objectPath: string;
    iface: string;           // e.g. "wlan0"
    activeAccessPointPath: string | null;
}