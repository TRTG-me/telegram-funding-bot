import WebSocket from 'ws';

type PriceUpdateCallback = (bid: string, ask: string) => void;

export class HyperliquidTickerService {
    private ws: WebSocket | null = null;
    private activeSymbol: string | null = null;

    // --- WATCHDOG ---
    private lastUpdateTimestamp: number = 0;
    private watchdogInterval: NodeJS.Timeout | null = null;
    private readonly STALE_DATA_TIMEOUT = 15000; // 15 секунд тишины = реконнект
    private isReconnecting = false;

    // --- ЛОГИКА ОГРАНИЧЕНИЯ ПОПЫТОК ---
    private reconnectAttempts = 0;
    private readonly MAX_RECONNECT_ATTEMPTS = 5; // После 10 неудач подряд выключаемся   

    constructor() {
        ;
    }

    public start(symbol: string, callback: PriceUpdateCallback): Promise<void> {
        const targetSymbol = symbol;

        // 1. Если меняем монету — сбрасываем старое
        if (this.ws && this.activeSymbol !== targetSymbol) {
            console.log(`Switching Hyperliquid from ${this.activeSymbol} to ${targetSymbol}.`);
            this.stop();
        }

        this.activeSymbol = targetSymbol;
        this.lastUpdateTimestamp = Date.now(); // Сброс таймера
        this.reconnectAttempts = 0; // Сброс счетчика при ручном старте

        return new Promise((resolve, reject) => {
            // Если уже подключены
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                resolve();
                return;
            }

            try {
                this.connectSocket(targetSymbol, callback, resolve, reject);
                this.startWatchdog(callback);
            } catch (e) {
                reject(e);
            }
        });
    }

    private connectSocket(
        symbol: string,
        callback: PriceUpdateCallback,
        resolve?: () => void,
        reject?: (err: any) => void
    ) {
        // Выбираем URL в зависимости от режима
        const wsUrl = 'wss://api.hyperliquid.xyz/ws'

        console.log(`Attempting to connect to Hyperliquid WebSocket (${symbol}) at ${wsUrl}...`);

        this.ws = new WebSocket(wsUrl);
        const currentConnection = this.ws;

        currentConnection.on('open', () => {
            if (this.activeSymbol !== symbol) {
                currentConnection.close();
                return;
            }
            console.log(`✅ Connected to Hyperliquid WS for ${symbol}.`);

            // !!! УСПЕХ: СБРАСЫВАЕМ СЧЕТЧИК НЕУДАЧ !!!
            this.reconnectAttempts = 0;

            // Подписываемся на L2 Book
            const subscriptionMessage = {
                method: 'subscribe',
                subscription: {
                    type: 'l2Book',
                    coin: symbol
                },
            };
            currentConnection.send(JSON.stringify(subscriptionMessage));

            if (resolve) resolve();
        });

        currentConnection.on('error', (error) => {
            console.error('Hyperliquid WS error:', error);
            if (reject) reject(error);
        });

        currentConnection.on('close', (code, reason) => {
            if (this.ws === currentConnection && code !== 1000) {
                console.warn(`Hyperliquid WS disconnected (${code}). Watchdog will handle reconnect.`);
            }
        });

        currentConnection.on('message', (data: WebSocket.Data) => {
            if (this.activeSymbol !== symbol) return;

            // !!! ОБНОВЛЯЕМ ПУЛЬС !!!
            this.lastUpdateTimestamp = Date.now();

            try {
                const message = JSON.parse(data.toString());

                if (message.channel === 'l2Book' && message.data) {
                    const bookData = message.data;

                    // Проверка, что данные именно для нашей монеты
                    if (bookData.coin !== this.activeSymbol) return;

                    // levels[0] = bids, levels[1] = asks
                    if (bookData.levels && bookData.levels.length >= 2) {
                        const bids = bookData.levels[0];
                        const asks = bookData.levels[1];

                        if (bids.length > 0 && asks.length > 0) {
                            const bestBid = bids[0].px;
                            const bestAsk = asks[0].px;
                            callback(bestBid, bestAsk);
                        }
                    }
                }
            } catch (error) {
                console.error('Error parsing Hyperliquid message:', error);
            }
        });
    }

    private startWatchdog(callback: PriceUpdateCallback) {
        if (this.watchdogInterval) clearInterval(this.watchdogInterval);

        this.watchdogInterval = setInterval(async () => {
            if (!this.activeSymbol || this.isReconnecting) return;

            const timeSinceLastUpdate = Date.now() - this.lastUpdateTimestamp;

            if (timeSinceLastUpdate > this.STALE_DATA_TIMEOUT) {

                // === ПРОВЕРКА НА ЛИМИТ ПОПЫТОК ===
                if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
                    console.error(`💥 [Hyperliquid] Max reconnect attempts (${this.MAX_RECONNECT_ATTEMPTS}) reached. Stopping ticker.`);
                    this.stop(true); // Полная остановка
                    return;
                }

                this.reconnectAttempts++;
                console.warn(`🚨 [Hyperliquid] STALE DATA! Attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS}. Reconnecting...`);

                this.isReconnecting = true;

                try {
                    // 1. Закрываем (false = не сбрасывать символ)
                    this.stop(false);

                    // 2. Переподключаемся
                    this.connectSocket(this.activeSymbol, callback);

                    this.lastUpdateTimestamp = Date.now();
                    // Сообщение об успехе будет в on('open')
                } catch (e) {
                    console.error('❌ [Hyperliquid] Reconnect failed:', e);
                } finally {
                    this.isReconnecting = false;
                }
            }
        }, 5000);
    }

    public stop(clearSymbol: boolean = true): void {
        if (clearSymbol) {
            this.activeSymbol = null;
            this.reconnectAttempts = 0;
            if (this.watchdogInterval) {
                clearInterval(this.watchdogInterval);
                this.watchdogInterval = null;
            }
        }

        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                    this.ws.terminate();
                }
            } catch (e) {
                // Ignore close errors
            } finally {
                this.ws = null;
            }
        }
    }
}