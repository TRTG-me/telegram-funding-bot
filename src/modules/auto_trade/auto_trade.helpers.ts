import { ExchangeName } from './auto_trade.service';
import { BinanceService } from '../binance/binance.service';
import { HyperliquidService } from '../hyperliquid/hyperliquid.service';

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
        case 'Hyperliquid': return finalCoin;
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
    services: { binance: BinanceService, hl: HyperliquidService }
): Promise<{ success: boolean, price?: number, error?: string }> {
    try {
        let symbol = await formatSymbol(exchange, coin);

        if (exchange === 'Binance') {
            const res = await services.binance.placeBinOrder(symbol, side, qty);

            // Polling ожидания исполнения
            let attempts = 0;
            while (attempts < 20) { // 10 секунд
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
            return { success: false, error: 'Binance Order Timeout (not FILLED)' };
        }

        else if (exchange === 'Hyperliquid') {
            // HL требует -PERP для ордеров
            if (!symbol.includes('-PERP')) symbol = symbol + '-PERP';

            const res = await services.hl.placeMarketOrder(symbol, side, qty);
            if (res.status === 'FILLED') {
                return { success: true, price: res.avgPrice };
            }
            return { success: false, error: `HL Status: ${res.status}` };
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
    services: { binance: BinanceService, hl: HyperliquidService }
): Promise<{ size: number, price: number }> { // Убрали null из типа возврата
    try {
        // ============ BINANCE ============
        if (exchange === 'Binance') {
            const targetSymbol = await formatSymbol('Binance', coin);
            // Если этот вызов упадет, сработает catch ниже (Ошибка API)
            const allPositions = await services.binance.getPositionInfo();

            const pos = allPositions.find(p =>
                p.symbol === targetSymbol &&
                p.positionAmt &&
                parseFloat(p.positionAmt) !== 0
            );

            if (pos) {
                return {
                    size: Math.abs(parseFloat(pos.positionAmt!)),
                    price: parseFloat(pos.entryPrice || '0')
                };
            }
        }

        // ============ HYPERLIQUID ============
        else if (exchange === 'Hyperliquid') {
            const targetCoin = coin.toUpperCase().replace('-PERP', '');
            // Если этот вызов упадет, сработает catch ниже (Ошибка API)
            const allPositions = await services.hl.getDetailedPositions();

            const pos = allPositions.find(p => p.coin === targetCoin);

            if (pos) {
                return {
                    size: pos.size,
                    price: pos.entryPrice || 0
                };
            }
        }

        // Если дошли сюда, значит API ответило, но позы нет -> Возвращаем 0
        return { size: 0, price: 0 };

    } catch (e: any) {
        // Пробрасываем ошибку дальше, чтобы сервис понял, что это сбой
        throw new Error(`API Error [${exchange}]: ${e.message}`);
    }
}