import WebSocket from 'ws';

type PriceUpdateCallback = (bid: string, ask: string) => void;

export class ExtendedTickerService {
    private ws: WebSocket | null = null;
    private activeSymbol: string | null = null;

    // --- WATCHDOG (ЗАЩИТА ОТ ПРОТУХАНИЯ) ---
    private lastUpdateTimestamp: number = 0;
    private watchdogInterval: NodeJS.Timeout | null = null;
    private readonly STALE_DATA_TIMEOUT = 30000; // 20 секунд тишины = реконнект
    private isReconnecting = false;

    // --- ЛОГИКА ОГРАНИЧЕНИЯ ПОПЫТОК ---
    private reconnectAttempts = 0;
    private readonly MAX_RECONNECT_ATTEMPTS = 5; // После 10 неудач подряд выключаемся

    constructor() { }

    public start(symbol: string, callback: PriceUpdateCallback): Promise<void> {
        // 1. Сбрасываем старое, если символ сменился
        if (this.ws && this.activeSymbol !== symbol) {
            console.log(`Switching Extended ticker from ${this.activeSymbol} to ${symbol}.`);
            this.stop();
        }

        this.activeSymbol = symbol;
        this.lastUpdateTimestamp = Date.now(); // Сброс таймера
        this.reconnectAttempts = 0; // Сброс счетчика при ручном старте

        return new Promise(async (resolve, reject) => {
            // Если уже подключены к этому же символу
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                resolve();
                return;
            }

            try {
                // Подключаемся
                this.connectSocket(symbol, callback, resolve, reject);

                // Запускаем охранника
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
        const connectionUrl = `wss://api.starknet.extended.exchange/stream.extended.exchange/v1/orderbooks/${symbol}?depth=1`;
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36'
            }
        };

        console.log(`Attempting to connect to Extended Exchange (${symbol})...`);

        this.ws = new WebSocket(connectionUrl, options);
        const currentConnection = this.ws;

        currentConnection.on('open', () => {
            if (this.activeSymbol !== symbol) {
                currentConnection.close();
                return;
            }

            console.log(`✅ Connected to Extended WS for ${symbol}`);

            // !!! УСПЕХ: СБРАСЫВАЕМ СЧЕТЧИК НЕУДАЧ !!!
            this.reconnectAttempts = 0;

            if (resolve) resolve();
        });

        currentConnection.on('error', (error) => {
            console.error('Extended WS error:', error);
            if (reject) reject(error);
        });

        currentConnection.on('close', (code, reason) => {
            // Если это не мы сами закрыли (не 1000), и это актуальный сокет
            if (code !== 1000 && this.ws === currentConnection) {
                console.warn(`Extended WS disconnected (${code}). Watchdog will handle reconnect.`);
            }
        });

        currentConnection.on('message', (data: WebSocket.Data) => {
            if (this.activeSymbol !== symbol) return;

            // !!! ОБНОВЛЯЕМ ПУЛЬС !!!
            this.lastUpdateTimestamp = Date.now();

            try {
                const message = JSON.parse(data.toString());

                // Extended шлет SNAPSHOT при подключении и UPDATE при изменениях.
                if (message.data) {
                    const priceData = message.data;

                    if (priceData.b && priceData.b.length > 0 && priceData.a && priceData.a.length > 0) {
                        const bestBid = priceData.b[0].p;
                        const bestAsk = priceData.a[0].p;

                        if (bestBid && bestAsk) {
                            callback(bestBid, bestAsk);
                        }
                    }
                }
            } catch (error) {
                console.error('Error parsing Extended message:', error);
            }
        });
    }

    private startWatchdog(callback: PriceUpdateCallback) {
        if (this.watchdogInterval) clearInterval(this.watchdogInterval);

        this.watchdogInterval = setInterval(async () => {
            // Если не активны или уже чинимся — выходим
            if (!this.activeSymbol || this.isReconnecting) return;

            const timeSinceLastUpdate = Date.now() - this.lastUpdateTimestamp;

            if (timeSinceLastUpdate > this.STALE_DATA_TIMEOUT) {

                // === ПРОВЕРКА НА ЛИМИТ ПОПЫТОК ===
                if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
                    console.error(`💥 [Extended] Max reconnect attempts (${this.MAX_RECONNECT_ATTEMPTS}) reached. Stopping ticker.`);
                    this.stop(true); // Полная остановка
                    return;
                }

                this.reconnectAttempts++;
                console.warn(`🚨 [Extended] STALE DATA! Attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS}. Reconnecting...`);

                this.isReconnecting = true;

                try {
                    // 1. Тихо закрываем старый сокет (false = не сбрасывать activeSymbol)
                    this.stop(false);

                    // 2. Создаем новый
                    this.connectSocket(this.activeSymbol, callback);

                    // 3. Обновляем время, чтобы сразу не сработало снова
                    this.lastUpdateTimestamp = Date.now();

                } catch (e) {
                    console.error('❌ [Extended] Reconnect failed:', e);
                } finally {
                    this.isReconnecting = false;
                }
            }
        }, 5000); // Проверка каждые 5 сек
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