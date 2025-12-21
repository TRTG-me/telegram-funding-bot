import WebSocket from 'ws';
import axios from 'axios';

type PriceUpdateCallback = (bid: string, ask: string) => void;

interface OrderLevel {
    price: string;
    size: string;
}

// Константы
const HTTP_TIMEOUT = 10000;
const STALE_DATA_TIMEOUT = 10000; // 10 секунд тишины = реконнект

export class ParadexTickerService {
    private ws: WebSocket | null = null;
    private subscriptionId: number = 1;
    private activeSymbol: string | null = null;

    // --- WATCHDOG ---
    private lastUpdateTimestamp: number = 0;
    private watchdogInterval: NodeJS.Timeout | null = null;
    private isReconnecting = false;

    // --- ЛОГИКА ОГРАНИЧЕНИЯ ПОПЫТОК ---
    private reconnectAttempts = 0;
    private readonly MAX_RECONNECT_ATTEMPTS = 5; // После 10 неудач подряд выключаемся

    // Храним tickSizeStr, чтобы при реконнекте не запрашивать его заново по HTTP
    private currentTickSizeStr: string | null = null;

    private readonly headers = {
        'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        'Origin': 'https://app.paradex.trade'
    };

    constructor() { }

    /**
     * Получает tick_size с таймаутом
     */
    private async getFormattedTickSize(symbol: string): Promise<string> {
        try {
            const url = `https://api.prod.paradex.trade/v1/markets?market=${symbol}`;
            const res = await axios.get(url, {
                headers: this.headers,
                timeout: HTTP_TIMEOUT
            });

            if (res.data && res.data.results && res.data.results.length > 0) {
                const tickSize = res.data.results[0].price_tick_size;
                if (tickSize) {
                    return tickSize.toString().replace('.', '_');
                }
            }
            throw new Error('Tick size not found');
        } catch (e: any) {
            console.warn(`[ParadexTicker] Failed to get tick size for ${symbol}, using default 0_01. Error: ${e.message}`);
            return '0_01';
        }
    }

    public async start(symbol: string, callback: PriceUpdateCallback): Promise<void> {
        // 1. Смена монеты
        if (this.ws && this.activeSymbol !== symbol) {
            console.log(`Switching Paradex ticker to ${symbol}...`);
            this.stop();
        }

        this.activeSymbol = symbol;
        this.lastUpdateTimestamp = Date.now();
        this.reconnectAttempts = 0; // Сброс счетчика при ручном старте

        // 2. Получаем (или обновляем) tick size только при первом старте
        // При реконнекте watchdog'ом мы будем использовать уже сохраненный
        const tickSizeStr = await this.getFormattedTickSize(symbol);
        this.currentTickSizeStr = tickSizeStr;

        return new Promise((resolve, reject) => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                resolve();
                return;
            }

            try {
                this.connectSocket(symbol, tickSizeStr, callback, resolve, reject);
                // Запускаем Watchdog, но передаем только callback (symbol берем из this.activeSymbol)
                this.startWatchdog(callback);
            } catch (e) {
                reject(e);
            }
        });
    }

    private connectSocket(
        symbol: string,
        tickSizeStr: string,
        callback: PriceUpdateCallback,
        resolve?: () => void,
        reject?: (err: any) => void
    ) {
        // Формируем канал: order_book.ETH-USD-PERP.interactive@15@100ms@0_01
        const channelName = `order_book.${symbol}.interactive@15@100ms@${tickSizeStr}`;
        const connectionUrl = 'wss://ws.api.prod.paradex.trade/v1?cancel-on-disconnect=false';

        console.log(`[Paradex] Connecting to RPI channel: ${channelName}`);

        this.ws = new WebSocket(connectionUrl, { headers: this.headers });
        const currentConnection = this.ws;

        currentConnection.on('open', () => {
            if (this.activeSymbol !== symbol) {
                currentConnection.close();
                return;
            }

            console.log(`✅ Connected to Paradex WS.`);

            // !!! УСПЕХ: СБРАСЫВАЕМ СЧЕТЧИК НЕУДАЧ !!!
            this.reconnectAttempts = 0;

            const subscriptionMessage = {
                jsonrpc: "2.0",
                method: "subscribe",
                params: { channel: channelName },
                id: this.subscriptionId++
            };
            currentConnection.send(JSON.stringify(subscriptionMessage));

            if (resolve) resolve();
        });

        currentConnection.on('error', (error) => {
            console.error('Paradex WS error:', error);
            if (reject) reject(error);
        });

        currentConnection.on('close', (code) => {
            if (this.ws === currentConnection) {
                if (code !== 1000) {
                    console.warn(`Paradex WS disconnected (${code}). Watchdog will handle reconnect.`);
                }
            }
        });

        currentConnection.on('message', (data: WebSocket.Data) => {
            if (this.activeSymbol !== symbol) return;

            // !!! ПУЛЬС !!!
            this.lastUpdateTimestamp = Date.now();

            try {
                const message = JSON.parse(data.toString());

                if (message.method === 'subscription' && message.params && message.params.data) {
                    const payload = message.params.data;

                    if (payload.inserts && Array.isArray(payload.inserts)) {
                        let bestBid = 0;
                        let bestAsk = Infinity;

                        for (const order of payload.inserts) {
                            const price = parseFloat(order.price);
                            if (order.side === 'BUY') {
                                if (price > bestBid) bestBid = price;
                            } else if (order.side === 'SELL') {
                                if (price < bestAsk) bestAsk = price;
                            }
                        }

                        if (bestBid > 0 && bestAsk !== Infinity) {
                            callback(bestBid.toString(), bestAsk.toString());
                        }
                    }
                }
            } catch (error) {
                console.error('Error parsing Paradex message:', error);
            }
        });
    }

    private startWatchdog(callback: PriceUpdateCallback) {
        if (this.watchdogInterval) clearInterval(this.watchdogInterval);

        this.watchdogInterval = setInterval(async () => {
            if (!this.activeSymbol || this.isReconnecting) return;

            const timeSinceLastUpdate = Date.now() - this.lastUpdateTimestamp;

            if (timeSinceLastUpdate > STALE_DATA_TIMEOUT) {

                // === ПРОВЕРКА НА ЛИМИТ ПОПЫТОК ===
                if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
                    console.error(`💥 [Paradex] Max reconnect attempts (${this.MAX_RECONNECT_ATTEMPTS}) reached. Stopping ticker.`);
                    this.stop(true); // Полная остановка
                    return;
                }

                this.reconnectAttempts++;
                console.warn(`🚨 [Paradex] STALE DATA! Attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS}. Reconnecting...`);
                this.isReconnecting = true;

                try {
                    // 1. Закрываем старое
                    this.stop(false);

                    // 2. Используем сохраненный tickSize
                    const tickStr = this.currentTickSizeStr || '0_01';

                    this.connectSocket(this.activeSymbol, tickStr, callback);

                    this.lastUpdateTimestamp = Date.now();
                    console.log('✅ [Paradex] Reconnected via Watchdog.');
                } catch (e) {
                    console.error('❌ [Paradex] Reconnect failed:', e);
                } finally {
                    this.isReconnecting = false;
                }
            }
        }, 5000);
    }

    public stop(clearSymbol: boolean = true): void {
        if (clearSymbol) {
            this.activeSymbol = null;
            this.currentTickSizeStr = null;
            this.reconnectAttempts = 0; // Сброс при полной остановке
            if (this.watchdogInterval) {
                clearInterval(this.watchdogInterval);
                this.watchdogInterval = null;
            }
        }

        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close(1000);
            this.ws = null;
        }
    }
}