import { ExchangeName } from './auto_trade.service';
import { BinanceService } from '../binance/binance.service';
import { HyperliquidService } from '../hyperliquid/hyperliquid.service';
import { ParadexService } from '../paradex/paradex.service';

// Описываем интерфейс сервисов, чтобы не писать длинные типы в аргументах
export interface ITradingServices {
    binance: BinanceService;
    hl: HyperliquidService;
    paradex: ParadexService;
}

// --- УТИЛИТЫ ---

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const roundFloat = (num: number, decimals: number = 4) =>
    parseFloat(num.toFixed(decimals));

// --- ЛОГИКА ТИКЕРОВ ---

export async function formatSymbol(exchange: ExchangeName, coin: string): Promise<string> {
    let finalCoin = coin.toUpperCase();
    const lower = coin.toLowerCase();

    // Спец. правила
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
        case 'Hyperliquid': return finalCoin; // Для сокета
        case 'Paradex': return `${finalCoin}-USD-PERP`;
        case 'Extended': return `${finalCoin}-USD`;
        case 'Lighter': return finalCoin;
        default: return finalCoin;
    }
}

// --- ЛОГИКА ТОРГОВЛИ ---

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

            let attempts = 0;
            while (attempts < 20) {
                if (res.clientOrderId) {
                    const orderInfo = await services.binance.getBinOrderInfo(symbol, res.clientOrderId);
                    if (orderInfo && orderInfo.status === 'FILLED') {
                        return { success: true, price: parseFloat(orderInfo.avgPrice) };
                    }
                } else {
                    return { success: false, error: 'No clientOrderId returned from Binance' };
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
            // Paradex ждет формат X-USD-PERP (formatSymbol это уже делает, но проверим)
            if (!symbol.endsWith('-USD-PERP')) symbol = `${symbol}-USD-PERP`;

            const res = await services.paradex.placeMarketOrder(symbol, side, qty);
            if (res.status === 'FILLED') {
                return { success: true, price: res.price };
            }
            return { success: false, error: `Paradex status: ${res.status}` };
        }

        return { success: false, error: `Exchange ${exchange} not supported` };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

// --- ЛОГИКА ДАННЫХ ---

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
                return {
                    size: Math.abs(parseFloat(pos.amt)),
                    price: parseFloat(pos.entryPrice)
                };
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
            const targetSymbol = await formatSymbol('Paradex', coin); // Вернет XXX-USD-PERP

            // Используем готовый метод поиска из сервиса (мы его добавили ранее)
            // Это избавляет от ручного перебора массива и ошибок типизации 'p'
            const pos = await services.paradex.getOpenPosition(targetSymbol);

            if (pos) {
                return {
                    size: pos.size,
                    price: pos.entryPrice || 0
                };
            }
        }

        // Если позиция не найдена (но API работает) -> Возвращаем 0
        return { size: 0, price: 0 };

    } catch (e: any) {
        throw new Error(`API Error [${exchange}]: ${e.message}`);
    }
}