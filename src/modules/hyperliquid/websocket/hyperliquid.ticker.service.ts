import WebSocket from 'ws';

type PriceUpdateCallback = (bid: string, ask: string) => void;

export class HyperliquidTickerService {
    private ws: WebSocket | null = null;
    // Хранение активного символа для фильтрации
    private activeSymbol: string | null = null;

    constructor() { }

    public start(symbol: string, callback: PriceUpdateCallback): Promise<void> {
        return new Promise((resolve, reject) => {

            // --- ИСПРАВЛЕНИЕ: Умная нормализация символа ---
            // 1. Сначала приводим к верхнему регистру для проверки
            let targetSymbol = symbol

            // 1. УПРАВЛЕНИЕ СОЕДИНЕНИЕМ
            if (this.ws) {
                // Если уже подписаны на ЭТУ ЖЕ монету - всё ок
                if (this.activeSymbol === targetSymbol && this.ws.readyState === WebSocket.OPEN) {
                    console.log(`Hyperliquid WebSocket already connected to ${targetSymbol}.`);
                    resolve();
                    return;
                }

                // Если монета ДРУГАЯ - закрываем старый сокет
                console.log(`Switching Hyperliquid from ${this.activeSymbol} to ${targetSymbol}. Reconnecting...`);
                this.stop();
            }

            // 2. ЗАПОМИНАЕМ НОВЫЙ СИМВОЛ (уже правильный, например kBONK)
            this.activeSymbol = targetSymbol;

            this.ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
            const currentConnection = this.ws;

            currentConnection.on('open', () => {
                console.log(`Connected to Hyperliquid WebSocket for ${targetSymbol}.`);

                // Подписываемся на L2 Book
                const subscriptionMessage = {
                    method: 'subscribe',
                    subscription: {
                        type: 'l2Book',
                        coin: targetSymbol // Отправляем kBONK
                    },
                };
                currentConnection.send(JSON.stringify(subscriptionMessage));
                resolve();
            });

            currentConnection.on('error', (error) => {
                console.error('Hyperliquid WebSocket error:', error);
                this.ws = null;
                this.activeSymbol = null;
                reject(error);
            });

            currentConnection.on('close', (code, reason) => {
                console.log(`Hyperliquid WebSocket disconnected: ${code} - ${reason.toString()}`);
                if (this.ws === currentConnection) {
                    this.ws = null;
                    this.activeSymbol = null;
                }
                if (code !== 1000) {
                    // reject сработает только при ошибке старта
                }
            });

            currentConnection.on('message', (data: WebSocket.Data) => {
                try {
                    const message = JSON.parse(data.toString());

                    if (message.channel === 'l2Book' && message.data) {
                        const bookData = message.data;

                        // === ФИЛЬТРАЦИЯ ===
                        // Hyperliquid вернет coin: "kBONK".
                        // Мы сравниваем с this.activeSymbol, который тоже теперь "kBONK".
                        if (bookData.coin !== this.activeSymbol) {
                            return;
                        }

                        if (bookData.levels && bookData.levels.length === 2) {
                            const bestBid = bookData.levels[0][0].px;
                            const bestAsk = bookData.levels[1][0].px;
                            callback(bestBid, bestAsk);
                        }
                    }
                } catch (error) {
                    console.error('Error parsing Hyperliquid message:', error);
                }
            });
        });
    }

    public stop(): void {
        if (this.ws) {
            console.log('Disconnecting from Hyperliquid WebSocket...');
            this.ws.removeAllListeners();
            this.ws.close(1000, 'Client initiated stop');
            this.ws = null;
            this.activeSymbol = null;
        }
    }
}