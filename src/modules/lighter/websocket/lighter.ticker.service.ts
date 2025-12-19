import WebSocket from 'ws';

// --- Интерфейсы ---
interface OrderLevel {
    price: string;
    size: string;
}

interface OrderBook {
    asks: OrderLevel[];
    bids: OrderLevel[];
}

type PriceUpdateCallback = (bid: string, ask: string) => void;

export class LighterTickerService {
    private ws: WebSocket | null = null;
    private orderBookStates = new Map<string, OrderBook>();
    private activeMarketIndex: string | null = null;

    // --- WATCHDOG ---
    private lastUpdateTimestamp: number = 0;
    private watchdogInterval: NodeJS.Timeout | null = null;
    // 20 секунд для DEX нормально (учитывая пинги)
    private readonly STALE_DATA_TIMEOUT = 20000;
    private isReconnecting = false;

    constructor() { }

    public start(marketIndex: string, callback: PriceUpdateCallback): Promise<void> {
        // 1. Смена маркета
        if (this.ws && this.activeMarketIndex !== marketIndex) {
            console.log(`Switching Lighter from ${this.activeMarketIndex} to ${marketIndex}.`);
            this.stop();
        }

        this.activeMarketIndex = marketIndex;
        this.lastUpdateTimestamp = Date.now(); // Сброс таймера

        return new Promise((resolve, reject) => {
            // Если уже подключены
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                resolve();
                return;
            }

            try {
                this.connectSocket(marketIndex, callback, resolve, reject);
                this.startWatchdog(callback);
            } catch (e) {
                reject(e);
            }
        });
    }

    private connectSocket(
        marketIndex: string,
        callback: PriceUpdateCallback,
        resolve?: () => void,
        reject?: (err: any) => void
    ) {
        // Очищаем стакан перед новым подключением
        this.orderBookStates.delete(marketIndex);

        const connectionUrl = 'wss://mainnet.zklighter.elliot.ai/stream';
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36',
                'Origin': 'https://mainnet.zklighter.elliot.ai'
            }
        };

        console.log(`Attempting to connect to Lighter WebSocket (Market ${marketIndex})...`);

        this.ws = new WebSocket(connectionUrl, options);
        const currentConnection = this.ws;

        currentConnection.on('open', () => {
            if (this.activeMarketIndex !== marketIndex) {
                currentConnection.close();
                return;
            }

            console.log(`✅ Connected to Lighter WS. Subscribing to ${marketIndex}...`);
            const subscriptionMessage = {
                type: "subscribe",
                channel: `order_book/${marketIndex}`
            };
            currentConnection.send(JSON.stringify(subscriptionMessage));
        });

        currentConnection.on('error', (error) => {
            console.error('Lighter WS error:', error);
            if (reject) reject(error);
        });

        currentConnection.on('close', (code, reason) => {
            if (this.ws === currentConnection) {
                // Не зануляем ws и activeMarketIndex здесь, если это реконнект
                // Это сделает stop() или connectSocket при следующем вызове
                if (code !== 1000) {
                    console.warn(`Lighter WS disconnected (${code}). Watchdog will handle reconnect.`);
                }
            }
        });

        currentConnection.on('message', (data: WebSocket.Data) => {
            if (this.activeMarketIndex !== marketIndex) return;

            // !!! ПУЛЬС !!!
            this.lastUpdateTimestamp = Date.now();

            try {
                const message = JSON.parse(data.toString());
                const messageType = message.type;

                switch (messageType) {
                    case 'ping':
                        // Пинг тоже считается активностью
                        currentConnection.send(JSON.stringify({ type: 'pong' }));
                        break;

                    case 'subscribed/order_book':
                        console.log(`Received SNAPSHOT for Lighter market ${marketIndex}.`);
                        this.orderBookStates.set(marketIndex, message.order_book);
                        if (resolve) resolve(); // Успешный старт
                        break;

                    case 'update/order_book':
                        this.handleOrderBookUpdate(marketIndex, message.order_book);
                        break;
                }

                // Отправка данных
                const currentState = this.orderBookStates.get(marketIndex);
                if (currentState && currentState.bids.length > 0 && currentState.asks.length > 0) {
                    callback(currentState.bids[0].price, currentState.asks[0].price);
                }
            } catch (error) {
                console.error('Error parsing Lighter message:', error);
            }
        });
    }

    private startWatchdog(callback: PriceUpdateCallback) {
        if (this.watchdogInterval) clearInterval(this.watchdogInterval);

        this.watchdogInterval = setInterval(async () => {
            if (!this.activeMarketIndex || this.isReconnecting) return;

            const timeSinceLastUpdate = Date.now() - this.lastUpdateTimestamp;

            if (timeSinceLastUpdate > this.STALE_DATA_TIMEOUT) {
                console.warn(`🚨 [Lighter] STALE DATA! No data/ping for ${timeSinceLastUpdate}ms. Reconnecting...`);
                this.isReconnecting = true;

                try {
                    // 1. Закрываем старое (false = не сбрасывать активный маркет)
                    this.stop(false);

                    // 2. Открываем новое
                    this.connectSocket(this.activeMarketIndex, callback);

                    this.lastUpdateTimestamp = Date.now();
                    console.log('✅ [Lighter] Reconnected via Watchdog.');
                } catch (e) {
                    console.error('❌ [Lighter] Reconnect failed:', e);
                } finally {
                    this.isReconnecting = false;
                }
            }
        }, 5000);
    }

    private handleOrderBookUpdate(marketIndex: string, delta: OrderBook): void {
        const currentState = this.orderBookStates.get(marketIndex);
        if (!currentState) return;

        this.updateSide(currentState.asks, delta.asks);
        this.updateSide(currentState.bids, delta.bids);

        currentState.asks.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
        currentState.bids.sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
    }

    private updateSide(existingLevels: OrderLevel[], newLevels: OrderLevel[]): void {
        for (const newLevel of newLevels) {
            const index = existingLevels.findIndex(level => level.price === newLevel.price);
            if (index !== -1) {
                if (parseFloat(newLevel.size) > 0) existingLevels[index].size = newLevel.size;
                else existingLevels.splice(index, 1);
            } else if (parseFloat(newLevel.size) > 0) {
                existingLevels.push(newLevel);
            }
        }
    }

    public stop(clearMarket: boolean = true): void {
        if (clearMarket) {
            this.activeMarketIndex = null;
            if (this.watchdogInterval) {
                clearInterval(this.watchdogInterval);
                this.watchdogInterval = null;
            }
        }

        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close(1000, 'Client stop');
            this.ws = null;
        }
        // Если полностью останавливаемся - чистим память стакана
        if (clearMarket && this.activeMarketIndex) {
            this.orderBookStates.delete(this.activeMarketIndex);
        }
    }
}