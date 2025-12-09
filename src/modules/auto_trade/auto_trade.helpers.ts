import { ExchangeName } from './auto_trade.service';
import { BinanceService } from '../binance/binance.service';
import { HyperliquidService } from '../hyperliquid/hyperliquid.service';
import { ParadexService } from '../paradex/paradex.service';
import { ExtendedService } from '../extended/extended.service';
import { LighterService } from '../lighter/lighter.service';

// Описываем интерфейс сервисов
export interface ITradingServices {
    binance: BinanceService;
    hl: HyperliquidService;
    paradex: ParadexService;
    extended: ExtendedService;
    lighter: LighterService;
}

// --- УТИЛИТЫ ---

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const roundFloat = (num: number, decimals: number = 4) =>
    parseFloat(num.toFixed(decimals));

// --- ЛОГИКА ТИКЕРОВ (Форматирование символов) ---

export async function formatSymbol(exchange: ExchangeName, coin: string): Promise<string> {
    let finalCoin = coin.toUpperCase();
    const lower = coin.toLowerCase();

    // Спец. правила (примеры)
    if (lower === 'kbonk' || lower === '1000bonk') {
        if (exchange === 'Binance' || exchange === 'Lighter') finalCoin = '1000BONK';
        else finalCoin = 'kBONK';
    } else if (lower === 'xyz100' || lower === 'tech100m') {
        if (exchange === 'Extended') finalCoin = 'TECH100M';
        else if (exchange === 'Hyperliquid') finalCoin = 'XYZ100';
        else finalCoin = 'TECH100m';
    }

    switch (exchange) {
        case 'Binance': return `${finalCoin}USDT`;
        case 'Hyperliquid': return finalCoin;
        case 'Paradex': return `${finalCoin}-USD-PERP`;
        case 'Extended': return `${finalCoin}-USD`; // Для Extended формат BTC-USD
        case 'Lighter': return finalCoin;
        default: return finalCoin;
    }
}

// --- ЛОГИКА ТОРГОВЛИ (EXECUTE TRADE) ---

export async function executeTrade(
    exchange: ExchangeName,
    coin: string,
    side: 'BUY' | 'SELL',
    qty: number,
    services: ITradingServices
): Promise<{ success: boolean, price?: number, error?: string }> {
    try {
        let symbol = await formatSymbol(exchange, coin);

        // ============ BINANCE ============
        if (exchange === 'Binance') {
            const res = await services.binance.placeBinOrder(symbol, side, qty);

            if (!res.clientOrderId) {
                return { success: false, error: 'No clientOrderId returned from Binance' };
            }

            let attempts = 0;
            while (attempts < 20) {
                // ДОБАВЛЯЕМ TRY-CATCH ВНУТРЬ ЦИКЛА
                try {
                    const orderInfo = await services.binance.getBinOrderInfo(symbol, res.clientOrderId);

                    if (orderInfo && orderInfo.status === 'FILLED') {
                        return { success: true, price: parseFloat(orderInfo.avgPrice) };
                    }
                } catch (e: any) {
                    // Если ошибка "Order does not exist", мы просто игнорируем ее 
                    // и даем циклу сработать снова через 0.5 сек.
                    if (!e.message?.includes('Order does not exist')) {
                        console.warn(`Binance retry warning: ${e.message}`);
                    }
                }

                await sleep(500);
                attempts++;
            }
            return { success: false, error: 'Binance Order Timeout' };
        }

        // ============ HYPERLIQUID ============
        else if (exchange === 'Hyperliquid') {
            if (!symbol.includes('-PERP')) symbol = symbol + '-PERP';
            const res = await services.hl.placeMarketOrder(symbol, side, qty);
            if (res.status === 'FILLED') {
                return { success: true, price: res.avgPrice };
            }
            return { success: false, error: `HL Status: ${res.status}` };
        }

        // ============ PARADEX ============
        else if (exchange === 'Paradex') {
            if (!symbol.endsWith('-USD-PERP')) symbol = `${symbol}-USD-PERP`;
            const res = await services.paradex.placeMarketOrder(symbol, side, qty);
            if (res.status === 'FILLED') {
                return { success: true, price: res.price };
            }
            return { success: false, error: `Paradex status: ${res.status}` };
        }

        // ============ EXTENDED ============
        else if (exchange === 'Extended') {
            // 1. Отправляем ордер
            // Возвращает { orderId (UUID), sentPrice, ... }
            const res = await services.extended.placeOrder(symbol, side, qty, 'MARKET');

            // 2. Цикл проверки (Polling)
            // Пытаемся получить реальную цену исполнения в течение 15 секунд
            let attempts = 0;
            const maxAttempts = 15;

            while (attempts < maxAttempts) {
                // Ждем 1 сек перед каждым запросом (даем время базе данных биржи)
                await sleep(1000);

                try {
                    // Запрашиваем детали по UUID
                    const rawDetails = await services.extended.getOrderDetails(res.orderId);

                    // API может вернуть массив или объект
                    const details = Array.isArray(rawDetails) ? rawDetails[0] : rawDetails;

                    if (details) {
                        // Пытаемся найти цену исполнения
                        // Приоритет: averagePrice (средняя цена исполнения) -> price (цена в ордере)
                        const priceStr = details.averagePrice || details.avgFillPrice || details.price;
                        const realPrice = parseFloat(priceStr);

                        // Если цена валидна (> 0), значит ордер найден и данные корректны
                        if (!isNaN(realPrice) && realPrice > 0) {
                            return { success: true, price: realPrice };
                        }
                    }
                } catch (e: any) {

                }

                attempts++;
            }

            // 3. FALLBACK (Запасной вариант)
            // Если за все попытки API истории так и не отдал данные (что бывает на тестнете),
            // но ордер при отправке (шаг 1) прошел успешно — мы не крашим бота.
            // Мы берем цену, которую рассчитывали при отправке (sentPrice).
            console.warn(`⚠️ Extended API timeout for UUID ${res.orderId}. Using calculated sentPrice.`);

            return { success: true, price: parseFloat(res.sentPrice) };
        }
        else if (exchange === 'Lighter') {
            // placeOrder сам внутри делает Polling по txHash
            // и возвращает { success: true, avgPrice: ..., status: ... }
            const res = await services.lighter.placeOrder(symbol, side, qty, 'MARKET');
            console.log('Lighter Order Result:', res);
            // СТРОГАЯ ПРОВЕРКА (Strict Mode)
            // Если статус ASSUMED (API 404/Timeout) или цена 0 — считаем это ошибкой для безопасности.
            if (res.status === 'ASSUMED_FILLED' || res.avgPrice <= 0) {
                return {
                    success: false,
                    error: `Lighter Unverified: ${res.status}. Tx: ${res.txHash}`
                };
            }

            // Если статус FILLED или PARTIALLY_FILLED
            return { success: true, price: res.avgPrice };
        }


        return { success: false, error: `Exchange ${exchange} not supported` };
    } catch (e: any) {
        // Логируем ошибку для отладки, но возвращаем объект
        console.error(`ExecTrade Error [${exchange}]:`, e.message);
        return { success: false, error: e.message };
    }
}

// --- ЛОГИКА ПОЗИЦИЙ (GET POSITION) ---

export async function getPositionData(
    exchange: ExchangeName,
    coin: string,
    services: ITradingServices
): Promise<{ size: number, price: number }> {
    try {
        // ============ BINANCE ============
        if (exchange === 'Binance') {
            const targetSymbol = await formatSymbol('Binance', coin);
            const pos = await services.binance.getOpenPosition(targetSymbol);
            if (pos) {
                return { size: Math.abs(parseFloat(pos.amt)), price: parseFloat(pos.entryPrice) };
            }
        }

        // ============ HYPERLIQUID ============
        else if (exchange === 'Hyperliquid') {
            const targetCoin = coin.toUpperCase().replace('-PERP', '');
            const pos = await services.hl.getOpenPosition(targetCoin);
            if (pos) {
                return { size: pos.size, price: pos.entryPrice || 0 };
            }
        }

        // ============ PARADEX ============
        else if (exchange === 'Paradex') {
            const targetSymbol = await formatSymbol('Paradex', coin);
            const pos = await services.paradex.getOpenPosition(targetSymbol);
            if (pos) {
                return { size: pos.size, price: pos.entryPrice || 0 };
            }
        }

        // ============ EXTENDED (Исправлено) ============
        else if (exchange === 'Extended') {
            // Метод getOpenPosition в сервисе сам почистит символ от "-USD" если надо
            const targetSymbol = await formatSymbol('Extended', coin);
            const pos = await services.extended.getOpenPosition(targetSymbol);

            if (pos) {
                return {
                    size: pos.size,      // Размер
                    price: pos.entryPrice || 0// Цена входа
                };
            }
        }
        else if (exchange === 'Lighter') {
            const targetSymbol = await formatSymbol('Lighter', coin);

            // Получаем список всех позиций через сервис
            const allPositions = await services.lighter.getDetailedPositions();

            // Ищем нужную
            const pos = allPositions.find(p => p.coin === targetSymbol || p.coin.includes(coin));

            if (pos) {
                return {
                    size: pos.size,
                    price: pos.entryPrice || 0
                };
            }
        }

        // Если позиция не найдена -> Возвращаем 0
        return { size: 0, price: 0 };

    } catch (e: any) {
        throw new Error(`API Error [${exchange}]: ${e.message}`);
    }
}