import {
    DerivativesTradingUsdsFutures,
    DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_PROD_URL
} from '@binance/derivatives-trading-usds-futures';

type PriceUpdateCallback = (bid: string, ask: string) => void;

export class BinanceTickerService {
    private client: DerivativesTradingUsdsFutures;
    private connection: any = null;
    private activeSymbol: string | null = null;

    // --- НОВОЕ: Для защиты от протухания ---
    private lastUpdateTimestamp: number = 0;
    private watchdogInterval: NodeJS.Timeout | null = null;
    private readonly STALE_DATA_TIMEOUT = 10000; // 10 секунд тишины = смерть
    private isReconnecting = false;
    private reconnectAttempts = 0;
    private readonly MAX_RECONNECT_ATTEMPTS = 5; // Сдаемся после 10 попыток
    // ---------------------------------------

    constructor() {
        this.client = new DerivativesTradingUsdsFutures({
            configurationWebsocketStreams: {
                wsURL: process.env.WS_STREAMS_URL ?? DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_PROD_URL,
            },
        });
    }

    public start(symbol: string, callback: PriceUpdateCallback): Promise<void> {
        this.activeSymbol = symbol;

        // Сбрасываем таймер "свежести" перед стартом
        this.lastUpdateTimestamp = Date.now();

        return new Promise(async (resolve, reject) => {
            // Если уже есть соединение, просто выходим (фильтр по activeSymbol сработает)
            if (this.connection) {
                console.warn('Binance WebSocket connection is already active.');
                resolve();
                return;
            }

            try {
                await this.connectSocket(symbol, callback);

                // --- НОВОЕ: Запускаем сторожевого пса ---
                this.startWatchdog(callback);

                resolve();
            } catch (error) {
                reject(error);
            }
        });
    }

    // Вынес логику подключения в отдельный метод для удобства реконнекта
    private async connectSocket(symbol: string, callback: PriceUpdateCallback) {
        console.log(`Attempting to connect to Binance WebSocket for ${symbol}...`);
        this.connection = await this.client.websocketStreams.connect();
        console.log('Binance WebSocket connection established.');

        const stream = this.connection.partialBookDepthStreams({
            symbol: symbol.toLowerCase(),
            levels: 5,
            updateSpeed: '100ms',
        });

        stream.on('message', (data: any) => {
            // 1. Обновляем время последнего пакета
            this.lastUpdateTimestamp = Date.now();

            if (data.s && data.s.toUpperCase() !== this.activeSymbol) {
                return;
            }

            if (data && data.b && data.b.length > 0 && data.a && data.a.length > 0) {
                const bestBid = data.b[0][0];
                const bestAsk = data.a[0][0];
                callback(bestBid, bestAsk);
            }
        });

        this.connection.on('close', (code: number) => {
            console.log(`Binance socket closed code: ${code}`);
            this.connection = null;
            // Если это не штатное закрытие и мы не в процессе реконнекта - можно попробовать переподключиться
            // Но watchdog и так это сделает
        });
    }

    private startWatchdog(callback: PriceUpdateCallback) {
        if (this.watchdogInterval) clearInterval(this.watchdogInterval);

        this.watchdogInterval = setInterval(async () => {
            // Если мы не отслеживаем ничего или уже переподключаемся — пропускаем
            if (!this.activeSymbol || this.isReconnecting) return;

            const timeSinceLastUpdate = Date.now() - this.lastUpdateTimestamp;

            if (timeSinceLastUpdate > this.STALE_DATA_TIMEOUT) {

                // === ПРОВЕРКА НА ЛИМИТ ПОПЫТОК ===
                if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
                    console.error(`💥 [Binance] Max reconnect attempts (${this.MAX_RECONNECT_ATTEMPTS}) reached. Stopping ticker.`);
                    // Полная остановка (очищает activeSymbol и убивает таймер)
                    this.stop(true);
                    return;
                }

                this.reconnectAttempts++;
                console.warn(`🚨 [Binance] STALE DATA! Attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS}. Reconnecting...`);

                this.isReconnecting = true;

                try {
                    // 1. Жестко убиваем старое соединение
                    await this.stop(false);

                    // 2. Пробуем подключиться заново
                    await this.connectSocket(this.activeSymbol, callback);

                    // 3. УСПЕХ: Сбрасываем счетчик неудач и обновляем время
                    this.reconnectAttempts = 0;
                    this.lastUpdateTimestamp = Date.now();
                    console.log('✅ Reconnection successful via Watchdog.');
                } catch (e) {
                    console.error('❌ Reconnection failed:', e);
                    // Счетчик попыток НЕ сбрасываем, он продолжает расти
                } finally {
                    this.isReconnecting = false;
                }
            }
        }, 5000);
    }

    public async stop(clearSymbol: boolean = true): Promise<void> {
        if (clearSymbol) {
            this.activeSymbol = null;
            if (this.watchdogInterval) {
                clearInterval(this.watchdogInterval);
                this.watchdogInterval = null;
            }
        }

        if (this.connection) {
            try {
                // Пытаемся закрыть
                if (typeof this.connection.disconnect === 'function') {
                    await this.connection.disconnect();
                } else if (typeof this.connection.close === 'function') {
                    this.connection.close();
                }
            } catch (error) {
                // Игнорируем ошибки при закрытии
            } finally {
                this.connection = null;
            }
        }
    }
}