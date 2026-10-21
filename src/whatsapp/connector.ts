/**
 * Connector adapter interface.
 *
 * The rest of the service only talks to this interface, so a different
 * WhatsApp library (or a different source entirely) can be substituted
 * without touching the database, parsing or website layers.
 */

export type SourcePost = {
	/** Stable per-post identifier provided by the source. */
	messageId: string;
	/** Secondary, source-native cursor (sequential id) when available. */
	serverId: string | null;
	/** ISO timestamp of the post as reported by the source. */
	timestamp: string | null;
	/** Post body text. */
	text: string;
	/** Optional structured metadata (views, forwards, reactions, media flags). */
	meta: Record<string, unknown> | null;
};

export type ChannelInfo = {
	id: string;
	name: string | null;
	invite: string | null;
	subscribers: number | null;
	verification: string | null;
};

export type ConnectorStatus = {
	connected: boolean;
	channelId: string | null;
	lastMessageAt: string | null;
	connectedAt: string | null;
	reconnects: number;
};

export type ConnectorEvents = {
	/** A post arrived live. */
	onPost: (post: SourcePost) => void | Promise<void>;
	/** Connection state changed. */
	onStatus: (status: ConnectorStatus) => void | Promise<void>;
	/** A recoverable error occurred. */
	onError: (err: unknown) => void | Promise<void>;
};

export interface Connector {
	/** Open the connection and restore/establish the session. */
	start(): Promise<void>;
	/** Close the connection cleanly. */
	stop(): Promise<void>;
	/** Wait until the socket is connected (the mex queries need it). */
	waitUntilConnected(timeoutMs?: number): Promise<void>;
	/** Resolve a channel URL / invite into channel metadata. */
	resolveChannel(urlOrInvite: string): Promise<ChannelInfo | null>;
	/**
	 * The channels this account follows.
	 * Discovered from the device's chat list (app-state sync).
	 */
	listChannels(timeoutMs?: number): Promise<string[]>;
	/** Fetch up to `count` most recent posts, optionally before a cursor. */
	fetchHistory(channelId: string, count: number, before?: string | null): Promise<SourcePost[]>;
	/** Read the whole available history of a channel, paging backwards. */
	fetchAllHistory(
		channelId: string,
		options?: { pageSize?: number; maxPages?: number }
	): Promise<{ posts: SourcePost[]; pages: number; exhausted: boolean }>;
	/** Start receiving live posts for the channel. */
	subscribe(channelId: string): Promise<void>;
	/** Re-assert the live subscription (the server-side window is ~90s). */
	refreshSubscription(channelId: string): Promise<void>;
	/** Current status snapshot. */
	status(): ConnectorStatus;
}
