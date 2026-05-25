import { useCallback, useEffect, useRef, useState } from "react";
import {
	List,
	ActionPanel,
	Action,
	Icon,
	Color,
	showToast,
	Toast,
	useNavigation,
	Form,
	confirmAlert,
	Alert,
	Detail,
} from "@vicinae/api";
import type { ActiveConnection, SavedConnection, WifiDevice, WifiNetwork } from "./types";
import {
	closeBus,
	connectNew,
	connectSaved,
	disconnectNetwork,
	forgetConnection,
	getAccessPoints,
	getActiveConnections,
	getSavedConnections,
	getWifiDevice,
	renameConnection,
	requestScan,
	setAutoconnect,
} from "./nm";

const POLL_MS = 4000;
const SCAN_STOP = 30_000;

// ── Signal icon ────────────────────────────────────────────────────────────

function signalIcon(strength: number, secured: boolean, active: boolean) {
	const tint = active ? Color.Green : Color.PrimaryText;
	let source: string;
	if (strength >= 80) source = Icon.Wifi;         // full
	else if (strength >= 55) source = Icon.Wifi;         // Vicinae may not have granular wifi icons
	else if (strength >= 30) source = Icon.Wifi;
	else source = Icon.Wifi;
	return { source, tintColor: tint };
}

function signalBars(strength: number): string {
	if (strength >= 80) return "▂▄▆█";
	if (strength >= 55) return "▂▄▆_";
	if (strength >= 30) return "▂▄__";
	return "▂___";
}

function freqLabel(mhz: number): string {
	return mhz >= 5000 ? "5 GHz" : "2.4 GHz";
}

// ── Password form ──────────────────────────────────────────────────────────

function PasswordForm({
	network,
	device,
	onDone,
}: {
	network: WifiNetwork;
	device: WifiDevice;
	onDone: () => void;
}) {
	const { pop } = useNavigation();
	const [password, setPassword] = useState("");

	return (
		<Form
			navigationTitle={`Connect to ${network.ssid}`}
			actions={
				<ActionPanel>
					<Action.SubmitForm
						title="Connect"
						onSubmit={async () => {
							const toast = await showToast({ style: Toast.Style.Animated, title: "Connecting…" });
							try {
								await connectNew(network.ssid, password || null, device.objectPath, network.objectPath);
								toast.style = Toast.Style.Success;
								toast.title = `Connected to ${network.ssid}`;
								onDone();
								pop();
							} catch (e: any) {
								toast.style = Toast.Style.Failure;
								toast.title = "Failed to connect";
								toast.message = e.message;
							}
						}}
					/>
				</ActionPanel>
			}
		>
			<Form.PasswordField
				id="password"
				title="Password"
				value={password}
				onChange={setPassword}
				autoFocus
			/>
		</Form>
	);
}

// ── Rename form ────────────────────────────────────────────────────────────

function RenameForm({
	connection,
	onDone,
}: {
	connection: SavedConnection;
	onDone: () => void;
}) {
	const { pop } = useNavigation();
	const [name, setName] = useState(connection.id);

	return (
		<Form
			navigationTitle={`Rename "${connection.id}"`}
			actions={
				<ActionPanel>
					<Action.SubmitForm
						title="Save"
						onSubmit={async () => {
							const toast = await showToast({ style: Toast.Style.Animated, title: "Renaming…" });
							try {
								await renameConnection(connection.objectPath, name);
								toast.style = Toast.Style.Success;
								toast.title = "Renamed";
								onDone();
								pop();
							} catch (e: any) {
								toast.style = Toast.Style.Failure;
								toast.title = "Failed to rename";
								toast.message = e.message;
							}
						}}
					/>
				</ActionPanel>
			}
		>
			<Form.TextField
				id="name"
				title="Name"
				value={name}
				onChange={setName}
				autoFocus
			/>
		</Form>
	);
}

// ── Detail view ────────────────────────────────────────────────────────────

function NetworkDetail({
	network,
	active,
}: {
	network: WifiNetwork;
	active: ActiveConnection | undefined;
}) {
	const md = `
# ${network.ssid}

| Property | Value |
|---|---|
| BSSID | ${network.bssid} |
| Signal | ${signalBars(network.strength)} ${network.strength}% |
| Frequency | ${freqLabel(network.frequency)} (${network.frequency} MHz) |
| Security | ${network.secured ? "WPA/WPA2" : "Open"} |
| Status | ${active ? "Connected" : "Not connected"} |
${active?.ip4Address ? `| IP Address | ${active.ip4Address} |` : ""}
  `.trim();

	return <Detail navigationTitle={network.ssid} markdown={md} />;
}

// ── Main command ───────────────────────────────────────────────────────────

export default function WifiCommand() {
	const { push } = useNavigation();

	const [device, setDevice] = useState<WifiDevice | null>(null);
	const [networks, setNetworks] = useState<WifiNetwork[]>([]);
	const [saved, setSaved] = useState<SavedConnection[]>([]);
	const [active, setActive] = useState<ActiveConnection[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [scanning, setScanning] = useState(false);
	const [section, setSection] = useState<"networks" | "saved">("networks");

	const pollRef = useRef<NodeJS.Timeout | null>(null);
	const scanTimer = useRef<NodeJS.Timeout | null>(null);

	// ── Fetch ──────────────────────────────────────────────────────────────

	const refresh = useCallback(async (silent = false) => {
		if (!silent) setIsLoading(true);
		try {
			const [dev, act, sav] = await Promise.all([
				getWifiDevice(),
				getActiveConnections(),
				getSavedConnections(),
			]);
			setDevice(dev);
			setActive(act);
			setSaved(sav);

			if (dev) {
				const aps = await getAccessPoints(dev.objectPath);
				setNetworks(aps);
			}
		} catch (e: any) {
			await showToast({
				style: Toast.Style.Failure,
				title: "NetworkManager error",
				message: e.message,
			});
		} finally {
			setIsLoading(false);
		}
	}, []);

	// ── Scan ───────────────────────────────────────────────────────────────

	const startScan = useCallback(async (dev: WifiDevice | null = device) => {
		if (!dev) return;
		try {
			await requestScan(dev.objectPath);
			setScanning(true);
			scanTimer.current = setTimeout(async () => {
				setScanning(false);
				await refresh(true);
			}, SCAN_STOP);
			// refresh APs a couple seconds after scan starts
			setTimeout(() => refresh(true), 3000);
		} catch (e: any) {
			await showToast({ style: Toast.Style.Failure, title: "Scan failed", message: e.message });
		}
	}, [device, refresh]);

	// ── Lifecycle ──────────────────────────────────────────────────────────

	useEffect(() => {
		refresh().then((dev) => startScan(device));
		pollRef.current = setInterval(() => refresh(true), POLL_MS);

		return () => {
			if (pollRef.current) clearInterval(pollRef.current);
			if (scanTimer.current) clearTimeout(scanTimer.current);
			closeBus();
		};
	}, []);

	// ── Helpers ────────────────────────────────────────────────────────────

	const activeForNetwork = (ssid: string) =>
		active.find((a) => a.ssid === ssid || a.id === ssid);

	const savedForNetwork = (ssid: string) =>
		saved.find((s) => s.ssid === ssid);

	// ── Global actions (always in every ActionPanel) ───────────────────────

	const globalActions = (
		<ActionPanel.Section title="Network Manager">
			<Action
				title={scanning ? "Scanning…" : "Scan for Networks"}
				icon={Icon.MagnifyingGlass}
				shortcut={{ modifiers: ["ctrl"], key: "s" }}
				onAction={() => startScan()}
			/>
			<Action
				title="Refresh"
				icon={Icon.ArrowClockwise}
				shortcut={{ modifiers: ["ctrl"], key: "r" }}
				onAction={() => refresh()}
			/>
		</ActionPanel.Section>
	);

	// ── Network actions ────────────────────────────────────────────────────

	const networkActions = (network: WifiNetwork) => {
		const act = activeForNetwork(network.ssid);
		const sav = savedForNetwork(network.ssid);

		return (
			<ActionPanel>
				{act ? (
					<Action
						title="Disconnect"
						icon={Icon.XMarkCircle}
						onAction={async () => {
							const toast = await showToast({ style: Toast.Style.Animated, title: "Disconnecting…" });
							try {
								await disconnectNetwork(act.objectPath);
								toast.style = Toast.Style.Success;
								toast.title = "Disconnected";
								await refresh(true);
							} catch (e: any) {
								toast.style = Toast.Style.Failure;
								toast.title = "Failed";
								toast.message = e.message;
							}
						}}
					/>
				) : sav ? (
					<Action
						title="Connect"
						icon={Icon.Plug}
						onAction={async () => {
							if (!device) return;
							const toast = await showToast({ style: Toast.Style.Animated, title: "Connecting…" });
							try {
								await connectSaved(sav.uuid, device.objectPath);
								toast.style = Toast.Style.Success;
								toast.title = `Connected to ${network.ssid}`;
								await refresh(true);
							} catch (e: any) {
								toast.style = Toast.Style.Failure;
								toast.title = "Failed";
								toast.message = e.message;
							}
						}}
					/>
				) : (
					<Action
						title={network.secured ? "Connect (enter password)" : "Connect"}
						icon={Icon.Plug}
						onAction={() => {
							if (!device) return;
							if (network.secured) {
								push(
									<PasswordForm
										network={network}
										device={device}
										onDone={() => refresh(true)}
									/>
								);
							} else {
								connectNew(network.ssid, null, device.objectPath, network.objectPath)
									.then(() => refresh(true))
									.catch(async (e) => {
										await showToast({ style: Toast.Style.Failure, title: "Failed", message: e.message });
									});
							}
						}}
					/>
				)}

				<Action
					title="View Details"
					icon={Icon.Info01}
					onAction={() => push(<NetworkDetail network={network} active={act} />)}
				/>

				{sav && (
					<>
						<Action
							title="Rename"
							icon={Icon.Pencil}
							onAction={() => push(<RenameForm connection={sav} onDone={() => refresh(true)} />)}
						/>
						<Action
							title={sav.autoconnect ? "Disable Auto-connect" : "Enable Auto-connect"}
							icon={sav.autoconnect ? Icon.Circle : Icon.CheckCircle}
							onAction={async () => {
								const toast = await showToast({ style: Toast.Style.Animated, title: "Updating…" });
								try {
									await setAutoconnect(sav.objectPath, !sav.autoconnect);
									toast.style = Toast.Style.Success;
									toast.title = sav.autoconnect ? "Auto-connect disabled" : "Auto-connect enabled";
									await refresh(true);
								} catch (e: any) {
									toast.style = Toast.Style.Failure;
									toast.title = "Failed";
									toast.message = e.message;
								}
							}}
						/>
						<Action
							title="Forget Network"
							icon={Icon.Trash}
							style={Action.Style.Destructive}
							onAction={async () => {
								const confirmed = await confirmAlert({
									title: "Forget Network",
									message: `Remove "${network.ssid}" from saved networks?`,
									primaryAction: { title: "Forget", style: Alert.ActionStyle.Destructive },
								});
								if (!confirmed) return;
								const toast = await showToast({ style: Toast.Style.Animated, title: "Forgetting…" });
								try {
									await forgetConnection(sav.objectPath);
									toast.style = Toast.Style.Success;
									toast.title = "Forgotten";
									await refresh(true);
								} catch (e: any) {
									toast.style = Toast.Style.Failure;
									toast.title = "Failed";
									toast.message = e.message;
								}
							}}
						/>
					</>
				)}

				{globalActions}
			</ActionPanel>
		);
	};

	// ── Saved connection actions ───────────────────────────────────────────

	const savedActions = (conn: SavedConnection) => {
		const act = active.find((a) => a.uuid === conn.uuid);

		return (
			<ActionPanel>
				{act ? (
					<Action
						title="Disconnect"
						icon={Icon.XMarkCircle}
						onAction={async () => {
							const toast = await showToast({ style: Toast.Style.Animated, title: "Disconnecting…" });
							try {
								await disconnectNetwork(act.objectPath);
								toast.style = Toast.Style.Success;
								toast.title = "Disconnected";
								await refresh(true);
							} catch (e: any) {
								toast.style = Toast.Style.Failure;
								toast.title = "Failed";
								toast.message = e.message;
							}
						}}
					/>
				) : (
					<Action
						title="Connect"
						icon={Icon.Plug}
						onAction={async () => {
							if (!device) return;
							const toast = await showToast({ style: Toast.Style.Animated, title: "Connecting…" });
							try {
								await connectSaved(conn.uuid, device.objectPath);
								toast.style = Toast.Style.Success;
								toast.title = `Connected to ${conn.ssid}`;
								await refresh(true);
							} catch (e: any) {
								toast.style = Toast.Style.Failure;
								toast.title = "Failed";
								toast.message = e.message;
							}
						}}
					/>
				)}

				<Action
					title="Rename"
					icon={Icon.Pencil}
					onAction={() => push(<RenameForm connection={conn} onDone={() => refresh(true)} />)}
				/>

				<Action
					title={conn.autoconnect ? "Disable Auto-connect" : "Enable Auto-connect"}
					icon={conn.autoconnect ? Icon.Circle : Icon.CheckCircle}
					onAction={async () => {
						const toast = await showToast({ style: Toast.Style.Animated, title: "Updating…" });
						try {
							await setAutoconnect(conn.objectPath, !conn.autoconnect);
							toast.style = Toast.Style.Success;
							toast.title = conn.autoconnect ? "Auto-connect disabled" : "Auto-connect enabled";
							await refresh(true);
						} catch (e: any) {
							toast.style = Toast.Style.Failure;
							toast.title = "Failed";
							toast.message = e.message;
						}
					}}
				/>

				<Action
					title="Forget Network"
					icon={Icon.Trash}
					style={Action.Style.Destructive}
					onAction={async () => {
						const confirmed = await confirmAlert({
							title: "Forget Network",
							message: `Remove "${conn.id}" from saved networks?`,
							primaryAction: { title: "Forget", style: Alert.ActionStyle.Destructive },
						});
						if (!confirmed) return;
						const toast = await showToast({ style: Toast.Style.Animated, title: "Forgetting…" });
						try {
							await forgetConnection(conn.objectPath);
							toast.style = Toast.Style.Success;
							toast.title = "Forgotten";
							await refresh(true);
						} catch (e: any) {
							toast.style = Toast.Style.Failure;
							toast.title = "Failed";
							toast.message = e.message;
						}
					}}
				/>

				{globalActions}
			</ActionPanel>
		);
	};

	// ── Render ─────────────────────────────────────────────────────────────

	return (
		<List
			isLoading={isLoading}
			searchBarPlaceholder="Search networks…"
			navigationTitle={scanning ? "Network Manager — Scanning…" : "Network Manager"}
			searchBarAccessory={
				<List.Dropdown
					tooltip="View"
					value={section}
					onChange={(v) => setSection(v as "networks" | "saved")}
				>
					<List.Dropdown.Item title="Nearby Networks" value="networks" />
					<List.Dropdown.Item title="Saved Connections" value="saved" />
				</List.Dropdown>
			}
		>
			{section === "networks" ? (
				<>
					{/* Currently connected */}
					<List.Section title="Connected">
						{networks
							.filter((n) => !!activeForNetwork(n.ssid))
							.map((n) => {
								const act = activeForNetwork(n.ssid)!;
								return (
									<List.Item
										key={n.bssid}
										icon={signalIcon(n.strength, n.secured, true)}
										title={n.ssid}
										subtitle={act.ip4Address ?? ""}
										accessories={[
											{ text: `${signalBars(n.strength)} ${freqLabel(n.frequency)}` },
											{ text: n.secured ? "🔒" : "🔓" },
										]}
										actions={networkActions(n)}
									/>
								);
							})}
					</List.Section>

					{/* Saved but not active */}
					<List.Section title="Saved">
						{networks
							.filter((n) => !activeForNetwork(n.ssid) && !!savedForNetwork(n.ssid))
							.map((n) => (
								<List.Item
									key={n.bssid}
									icon={signalIcon(n.strength, n.secured, false)}
									title={n.ssid}
									subtitle={`Saved · ${freqLabel(n.frequency)}`}
									accessories={[
										{ text: `${signalBars(n.strength)}` },
										{ text: n.secured ? "🔒" : "🔓" },
									]}
									actions={networkActions(n)}
								/>
							))}
					</List.Section>

					{/* Other nearby */}
					<List.Section title="Other Networks">
						{networks
							.filter((n) => !activeForNetwork(n.ssid) && !savedForNetwork(n.ssid))
							.map((n) => (
								<List.Item
									key={n.bssid}
									icon={signalIcon(n.strength, n.secured, false)}
									title={n.ssid}
									subtitle={freqLabel(n.frequency)}
									accessories={[
										{ text: `${signalBars(n.strength)}` },
										{ text: n.secured ? "🔒" : "🔓" },
									]}
									actions={networkActions(n)}
								/>
							))}
					</List.Section>
				</>
			) : (
				<List.Section title="Saved Connections">
					{saved.map((conn) => {
						const act = active.find((a) => a.uuid === conn.uuid);
						return (
							<List.Item
								key={conn.uuid}
								icon={act ? { source: Icon.Wifi, tintColor: Color.Green } : Icon.Wifi}
								title={conn.id}
								subtitle={conn.ssid !== conn.id ? conn.ssid : undefined}
								accessories={[
									act ? { text: "Connected", icon: { source: Icon.Circle, tintColor: Color.Green } } : {},
									{ text: conn.autoconnect ? "Auto" : "" },
								]}
								actions={savedActions(conn)}
							/>
						);
					})}
				</List.Section>
			)}
		</List>
	);
}