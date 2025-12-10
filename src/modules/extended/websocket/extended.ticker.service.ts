import WebSocket from 'ws';

type PriceUpdateCallback = (bid: string, ask: string) => void;

export class ExtendedTickerService {
    private ws: WebSocket | null = null;
    // Добавляем хранение текущего символа
    private activeSymbol: string | null = null;

    constructor() { }

    public start(symbol: string, callback: PriceUpdateCallback): Promise<void> {
        return new Promise((resolve, reject) => {
            const upperSymbol = symbol.toUpperCase();

            // 1. ПРОВЕРКА: Если сокет есть
            if (this.ws) {
                // Если мы уже подписаны на ЭТУ ЖЕ монету - всё ок, выходим
                if (this.activeSymbol === upperSymbol && this.ws.readyState === WebSocket.OPEN) {
                    console.log(`Extended WebSocket is already connected to ${upperSymbol}.`);
                    resolve();
                    return;
                }

                // Если монета ДРУГАЯ - нужно закрыть старое соединение!
                console.log(`Switching Extended ticker from ${this.activeSymbol} to ${upperSymbol}. Closing old connection...`);
                this.stop();
                // stop() синхронно закрывает и обнуляет this.ws, так что идем дальше создавать новый
            }

            // 2. ЗАПОМИНАЕМ НОВЫЙ СИМВОЛ
            this.activeSymbol = upperSymbol;

            // 3. СОЗДАЕМ НОВОЕ ПОДКЛЮЧЕНИЕ
            // URL зависит от символа, поэтому для новой монеты нужен новый URL
            const connectionUrl = `wss://api.starknet.extended.exchange/stream.extended.exchange/v1/orderbooks/${upperSymbol}?depth=1`;
            const options = {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36'
                }
            };

            console.log(`Attempting to connect to Extended Exchange at: ${connectionUrl}`);
            this.ws = new WebSocket(connectionUrl, options);
            const currentConnection = this.ws;

            currentConnection.on('open', () => {
                // Дополнительная проверка на случай гонки (если пока коннектились, уже нажали стоп)
                if (this.activeSymbol !== upperSymbol) {
                    currentConnection.close();
                    return;
                }
                console.log(`Successfully connected to Extended Exchange WebSocket for ${upperSymbol}. Waiting for data...`);
                resolve();
            });

            currentConnection.on('error', (error) => {
                console.error('Extended Exchange WebSocket error:', error);
                this.ws = null;
                this.activeSymbol = null;
                reject(error);
            });

            currentConnection.on('close', (code, reason) => {
                console.log(`Extended Exchange WebSocket disconnected: ${code} - ${reason.toString()}`);
                if (code !== 1000) {
                    // reject сработает только если это произошло ДО resolve (во время подключения)
                    // после resolve это будет Unhandled Rejection, что не страшно, если есть защита в main.ts
                    // Но для чистоты можно не реджектить, если уже открыто было.
                }
                // Не обнуляем this.ws здесь жестко, так как stop() делает это сам, 
                // а это событие может прилететь с задержкой от старого сокета.
                // Проверяем: это наш текущий сокет закрылся?
                if (this.ws === currentConnection) {
                    this.ws = null;
                    this.activeSymbol = null;
                }
            });

            currentConnection.on('message', (data: WebSocket.Data) => {
                // ЗАЩИТА ОТ ГОНКИ ДАННЫХ
                // Если этот сокет относится к символу, который нам уже не нужен - игнорируем
                if (this.activeSymbol !== upperSymbol) return;

                try {
                    const message = JSON.parse(data.toString());
                    if (message.type === 'SNAPSHOT' && message.data) {
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
                    console.error('Error parsing Extended Exchange message:', error);
                }
            });
        });
    }

    public stop(): void {
        if (this.ws) {
            console.log('Disconnecting from Extended Exchange WebSocket...');
            this.ws.removeAllListeners(); // Убираем слушатели, чтобы не триггерить 'close' или 'error' после ручного закрытия
            this.ws.close(1000, 'Client initiated stop');
            this.ws = null;
            this.activeSymbol = null;
        }
    }
}