import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { getUnixTime, subDays } from 'date-fns';
import { TotalPositionsService, HedgedPair, UnhedgedPosition } from '../totalPositions/totalPositions.service';
import { IFundingResultRow, IHistoricalFundingData, IUnhedgedFundingResultRow, IFundingToolsData, IFundingToolsResponse, IParadexMarket, IParadexMarketsResponse } from '../../common/interfaces';


@Injectable()
export class TotalFundingsService {
    private readonly FUNDING_TOOLS_API_URL = 'https://funding.tools/api/funding-data/diff/historical_differences';
    private readonly PARADEX_API_URL = 'https://api.prod.paradex.trade/v1';
    private readonly DUMMY_EXCHANGE_FOR_UNHEDGED = 'P'; // Используем Paradex как "мусорную" биржу

    private readonly exchangeMap: Record<string, string> = {
        'B': 'binance_usd-m', 'L': 'lighter', 'E': 'extended', 'H': 'hyperliquid', 'P': 'paradex',
    };
    private readonly reverseExchangeMap: Record<string, string>;
    private paradexMarketDataCache = new Map<string, number>();

    constructor(private readonly totalPositionsService: TotalPositionsService) {
        this.reverseExchangeMap = Object.fromEntries(
            Object.entries(this.exchangeMap).map(([key, value]) => [value, key])
        );
    }

    private async _cacheParadexMarketData(): Promise<void> {
        try {
            console.log('Caching Paradex market data...');
            const response = await axios.get<IParadexMarketsResponse>(`${this.PARADEX_API_URL}/markets`);
            this.paradexMarketDataCache.clear();
            for (const market of response.data.results) {
                if (market.base_currency && market.funding_period_hours) {
                    this.paradexMarketDataCache.set(market.base_currency, market.funding_period_hours);
                }
            }
            console.log(`Cached data for ${this.paradexMarketDataCache.size} Paradex markets.`);
        } catch (error) {
            console.error('Failed to cache Paradex market data:', error);
        }
    }

    public async getHistoricalFunding(): Promise<IHistoricalFundingData> {
        const { hedgedPairs, unhedgedPositions } = await this.totalPositionsService.getAggregatedPositions();

        const needsParadexData = hedgedPairs.some(p => p.exchanges.includes('P')) ||
            unhedgedPositions.some(p => p.exchange === 'P');
        if (needsParadexData) {
            await this._cacheParadexMarketData();
        }

        const [hedgedResults, unhedgedResults] = await Promise.all([
            Promise.all(hedgedPairs.map(pair => this._fetchFundingForPair(pair))),
            Promise.all(unhedgedPositions.map(pos => this._fetchFundingForUnhedged(pos)))
        ]);

        hedgedResults.sort((a, b) => b.notional - a.notional);
        unhedgedResults.sort((a, b) => b.notional - a.notional);

        return { hedged: hedgedResults, unhedged: unhedgedResults };
    }

    private async _fetchFundingForPair(pair: HedgedPair): Promise<IFundingResultRow> {
        const timeIntervals = [1, 3, 7, 14];
        const fundingDiffs = await Promise.all(
            timeIntervals.map(days => this._fetchSingleFundingDiff(pair, days))
        );
        return {
            coin: pair.coin, notional: pair.notional, exchanges: pair.exchanges,
            funding_1d: fundingDiffs[0], funding_3d: fundingDiffs[1],
            funding_7d: fundingDiffs[2], funding_14d: fundingDiffs[3],
        };
    }

    private async _fetchFundingForUnhedged(pos: UnhedgedPosition): Promise<IUnhedgedFundingResultRow> {
        const timeIntervals = [1, 3, 7, 14];
        const fundingRates = await Promise.all(
            timeIntervals.map(days => this._fetchSingleFundingDiff(pos, days))
        );
        return {
            coin: pos.coin, notional: pos.notional, exchange: pos.exchange, side: pos.side,
            funding_1d: fundingRates[0], funding_3d: fundingRates[1],
            funding_7d: fundingRates[2], funding_14d: fundingRates[3],
        };
    }

    private async _fetchSingleFundingDiff(item: HedgedPair | UnhedgedPosition, days: number): Promise<number> {
        try {
            const isHedged = 'exchanges' in item;
            let longExchangeCode: string | null = null;
            let shortExchangeCode: string | null = null;
            let targetExchangeCode: string;

            if (isHedged) {
                [longExchangeCode, shortExchangeCode] = item.exchanges.split('-');
                targetExchangeCode = longExchangeCode; // Неважно, для запроса нужны обе
            } else {
                targetExchangeCode = item.exchange;
                if (item.side === 'LONG') longExchangeCode = item.exchange;
                else shortExchangeCode = item.exchange;
            }

            const sectionNames = isHedged
                ? [this.exchangeMap[longExchangeCode!], this.exchangeMap[shortExchangeCode!]]
                // Для анхеджа добавляем "мусорную" биржу
                : [this.exchangeMap[targetExchangeCode], this.exchangeMap[this.DUMMY_EXCHANGE_FOR_UNHEDGED]];

            if (sectionNames.some(name => !name)) return 0;

            const toTs = getUnixTime(new Date());
            const fromTs = getUnixTime(subDays(new Date(), days));
            const params = new URLSearchParams({
                asset_names: item.coin, normalize_to_interval: 'raw',
                from_ts: fromTs.toString(), to_ts: toTs.toString(), buffer: '30',
            });
            sectionNames.forEach(name => params.append('section_names', name));
            params.append('quote_names', 'USD');
            params.append('quote_names', 'USDT');

            const response = await axios.get<IFundingToolsResponse>(this.FUNDING_TOOLS_API_URL, { params });
            const fundingData = response.data?.data?.[0];
            if (!fundingData?.contract_1_section || !fundingData?.contract_2_section) return 0;

            let calculatedValue = 0;
            const contracts = [
                { section: fundingData.contract_1_section, funding: fundingData.contract_1_total_funding || 0 },
                { section: fundingData.contract_2_section, funding: fundingData.contract_2_total_funding || 0 }
            ];

            for (const contract of contracts) {
                const code = this.reverseExchangeMap[contract.section];
                let fundingValue = contract.funding;

                if (code === 'P') {
                    const fundingPeriodHours = this.paradexMarketDataCache.get(item.coin);
                    if (fundingPeriodHours && fundingPeriodHours > 0) {
                        fundingValue = (fundingValue * 8) / fundingPeriodHours;
                    } else {
                        console.warn(`[Paradex Adjustment] Could not find funding_period_hours for coin: ${item.coin}`);
                    }
                }

                if (isHedged) {
                    if (code === shortExchangeCode) calculatedValue += fundingValue;
                    else if (code === longExchangeCode) calculatedValue -= fundingValue;
                } else {
                    if (code === targetExchangeCode) {
                        calculatedValue = fundingValue;
                        break;
                    }
                }
            }

            if (days === 0) return 0;
            const annualizedPercentage = (calculatedValue / days) * 365 * 100;

            if (!isHedged && item.side === 'SHORT') {
                return -annualizedPercentage;
            }

            return annualizedPercentage;

        } catch (error) {
            console.error(`Failed to fetch funding for ${item.coin} for ${days} days:`, error);
            return 0;
        }
    }
}