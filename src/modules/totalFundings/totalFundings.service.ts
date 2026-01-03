import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { TotalPositionsService, HedgedPair, UnhedgedPosition } from '../totalPositions/totalPositions.service';
import { IFundingResultRow, IUnhedgedFundingResultRow, IHistoricalFundingData } from '../../common/interfaces';

@Injectable()
export class TotalFundingsService {
    private readonly BOT_API_URL = 'http://localhost:3000/api';

    private readonly exchangeMap: Record<string, string> = {
        'B': 'Binance',
        'L': 'Lighter',
        'E': 'Extended',
        'H': 'Hyperliquid',
        'P': 'Paradex',
    };

    constructor(private readonly totalPositionsService: TotalPositionsService) { }

    public async getHistoricalFunding(userId?: number): Promise<IHistoricalFundingData> {
        const { hedgedPairs, unhedgedPositions } = await this.totalPositionsService.getAggregatedPositions(userId);

        // Группируем по монетам, чтобы минимизировать количество запросов к API
        const coinMap = new Map<string, string[]>();

        hedgedPairs.forEach(p => {
            const [ex1Code, ex2Code] = p.exchanges.split('-');
            if (!coinMap.has(p.coin)) coinMap.set(p.coin, []);
            const list = coinMap.get(p.coin)!;
            const ex1Name = this.exchangeMap[ex1Code];
            const ex2Name = this.exchangeMap[ex2Code];
            if (ex1Name && !list.includes(ex1Name)) list.push(ex1Name);
            if (ex2Name && !list.includes(ex2Name)) list.push(ex2Name);
        });

        unhedgedPositions.forEach(p => {
            if (!coinMap.has(p.coin)) coinMap.set(p.coin, []);
            const list = coinMap.get(p.coin)!;
            const exName = this.exchangeMap[p.exchange];
            if (exName && !list.includes(exName)) list.push(exName);
        });

        // Запрашиваем данные для каждой монеты
        const coinDataResults = await Promise.all(
            Array.from(coinMap.entries()).map(async ([coin, exchanges]) => {
                try {
                    const url = `${this.BOT_API_URL}/coin/${coin}`;
                    const params = { exchanges: exchanges.join(',') };
                    const response = await axios.get(url, { params, timeout: 10000 });
                    return { coin, data: response.data };
                } catch (e: any) {
                    console.error(`[TotalFundingsService] Failed to fetch funding for ${coin}:`, e.message);
                    return { coin, data: null };
                }
            })
        );

        const dataByCoin = new Map<string, any>();
        coinDataResults.forEach(r => dataByCoin.set(r.coin, r.data));

        // Обработка хеджированных пар
        const hedgedResults: IFundingResultRow[] = hedgedPairs.map(pair => {
            const coinData = dataByCoin.get(pair.coin);
            const [ex1Code, ex2Code] = pair.exchanges.split('-'); // ex1 = Long, ex2 = Short
            const ex1Name = this.exchangeMap[ex1Code];
            const ex2Name = this.exchangeMap[ex2Code];

            const result: IFundingResultRow = {
                coin: pair.coin,
                notional: pair.notional,
                exchanges: pair.exchanges,
                funding_8h: 0,
                funding_1d: 0,
                funding_3d: 0,
                funding_7d: 0,
                funding_14d: 0
            };

            if (coinData && coinData.comparisons && Array.isArray(coinData.comparisons)) {
                // Ищем сравнение для этой пары (Binance vs Paradex или Paradex vs Binance)
                const comp = coinData.comparisons.find((c: any) =>
                    c.pair.includes(ex1Name) && c.pair.includes(ex2Name)
                );

                if (comp) {
                    const isEx1FirstValue = comp.pair.startsWith(ex1Name);
                    // Мы хотим APR(Short) - APR(Long)
                    // Если Ex1 (Long) первый в сравнении, то diff = Ex1 - Ex2. Нам нужно Ex2 - Ex1 = -diff.
                    const multiplier = isEx1FirstValue ? -1 : 1;

                    comp.results.forEach((r: any) => {
                        const val = r.diff * multiplier;
                        if (r.period === '8h') result.funding_8h = val;
                        else if (r.period === '1d') result.funding_1d = val;
                        else if (r.period === '3d') result.funding_3d = val;
                        else if (r.period === '7d') result.funding_7d = val;
                        else if (r.period === '14d') result.funding_14d = val;
                    });
                }
            }

            return result;
        });

        // Обработка нехеджированных позиций
        const unhedgedResults: IUnhedgedFundingResultRow[] = unhedgedPositions.map(pos => {
            const coinData = dataByCoin.get(pos.coin);
            const exName = this.exchangeMap[pos.exchange];

            const result: IUnhedgedFundingResultRow = {
                coin: pos.coin,
                notional: pos.notional,
                exchange: pos.exchange,
                side: pos.side,
                funding_8h: 0,
                funding_1d: 0,
                funding_3d: 0,
                funding_7d: 0,
                funding_14d: 0
            };

            if (coinData) {
                // Если есть сравнения, берем APR нужной биржи из любого
                const comp = (coinData.comparisons || []).find((c: any) => c.pair.includes(exName));
                if (comp) {
                    const isExFirst = comp.pair.startsWith(exName);
                    comp.results.forEach((r: any) => {
                        const apr = isExFirst ? r.apr1 : r.apr2;
                        // Если мы в лонге, мы платим фандинг (отрицательная доходность), если в шорте - получаем
                        const finalVal = pos.side === 'LONG' ? -apr : apr;

                        if (r.period === '8h') result.funding_8h = finalVal;
                        else if (r.period === '1d') result.funding_1d = finalVal;
                        else if (r.period === '3d') result.funding_3d = finalVal;
                        else if (r.period === '7d') result.funding_7d = finalVal;
                        else if (r.period === '14d') result.funding_14d = finalVal;
                    });
                } else if (coinData.histories) {
                    // Если сравнений нет (только одна биржа), считаем среднее из истории
                    const historyObj = coinData.histories.find((h: any) => h.exchange === exName);
                    if (historyObj && historyObj.history) {
                        const h = historyObj.history;
                        const calculateAvg = (hours: number) => {
                            const now = Date.now();
                            const limit = now - hours * 60 * 60 * 1000;
                            const samples = h.filter((s: any) => s.date >= limit);
                            if (samples.length === 0) return 0;
                            const sum = samples.reduce((acc: number, s: any) => acc + s.rate, 0);
                            return sum / samples.length;
                        };

                        const periods = { '8h': 8, '1d': 24, '3d': 72, '7d': 168, '14d': 336 };
                        Object.entries(periods).forEach(([p, hours]) => {
                            const apr = calculateAvg(hours);
                            const finalVal = pos.side === 'LONG' ? -apr : apr;
                            if (p === '8h') result.funding_8h = finalVal;
                            else if (p === '1d') result.funding_1d = finalVal;
                            else if (p === '3d') result.funding_3d = finalVal;
                            else if (p === '7d') result.funding_7d = finalVal;
                            else if (p === '14d') result.funding_14d = finalVal;
                        });
                    }
                }
            }

            return result;
        });

        hedgedResults.sort((a, b) => b.notional - a.notional);
        unhedgedResults.sort((a, b) => b.notional - a.notional);

        return { hedged: hedgedResults, unhedged: unhedgedResults };
    }
}