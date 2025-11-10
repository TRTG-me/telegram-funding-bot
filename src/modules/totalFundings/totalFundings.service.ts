import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { getUnixTime, subDays } from 'date-fns';
import { TotalPositionsService, HedgedPair, UnhedgedPosition } from '../totalPositions/totalPositions.service';
import { IFundingResultRow, IHistoricalFundingData, IUnhedgedFundingResultRow, IFundingToolsResponse, IParadexMarketsResponse } from '../../common/interfaces';

// --- Добавляем локальные интерфейсы, если они не в общем файле ---
interface ParadexMarket {
    base_currency?: string;
    funding_period_hours?: number;
    asset_kind?: string;
}
interface ParadexMarketsResponse { results: ParadexMarket[]; }


@Injectable()
export class TotalFundingsService {
    private readonly FUNDING_TOOLS_API_URL = 'https://funding.tools/api/funding-data/diff/historical_differences';
    private readonly PARADEX_API_URL = 'https://api.prod.paradex.trade/v1';

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
            const response = await axios.get<ParadexMarketsResponse>(`${this.PARADEX_API_URL}/markets`);
            this.paradexMarketDataCache.clear();
            for (const market of response.data.results) {
                if (
                    market.asset_kind === 'PERP' &&
                    market.base_currency &&
                    market.funding_period_hours
                ) {
                    this.paradexMarketDataCache.set(market.base_currency, market.funding_period_hours);
                }
            }
            console.log(`Cached data for ${this.paradexMarketDataCache.size} Paradex perpetual markets.`);
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
            const toTs = getUnixTime(new Date());
            const fromTs = getUnixTime(subDays(new Date(), days));

            let annualizedPercentage = 0;

            if (isHedged) {
                // --- ЛОГИКА ДЛЯ ХЕДЖИРОВАННЫХ ПАР ---
                const [longExchangeCode, shortExchangeCode] = item.exchanges.split('-');
                const sectionNames = [this.exchangeMap[longExchangeCode], this.exchangeMap[shortExchangeCode]];
                if (sectionNames.some(name => !name)) return 0;

                const params = new URLSearchParams({
                    asset_names: item.coin, normalize_to_interval: 'raw',
                    from_ts: fromTs.toString(), to_ts: toTs.toString(), buffer: '30',
                });
                sectionNames.forEach(name => { if (name) params.append('section_names', name) });
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
                        }
                    }
                    if (code === shortExchangeCode) calculatedValue += fundingValue;
                    else if (code === longExchangeCode) calculatedValue -= fundingValue;
                }
                if (days > 0) {
                    annualizedPercentage = (calculatedValue / days) * 365 * 100;
                }
            } else {
                // --- ЛОГИКА ДЛЯ НЕХЕДЖИРОВАННЫХ ПАР ---
                const targetSectionName = this.exchangeMap[item.exchange];
                if (!targetSectionName) return 0;

                const isParadex = item.exchange === 'P';

                const params = new URLSearchParams({
                    asset_names: item.coin,
                    compare_for_section: targetSectionName,
                    normalize_to_interval: isParadex ? '365d' : 'raw',
                    from_ts: fromTs.toString(),
                    to_ts: toTs.toString(),
                    buffer_minutes: '30',
                });

                if (!isParadex) {
                    params.append('quote_names', 'USD');
                    params.append('quote_names', 'USDT');
                }

                const response = await axios.get<IFundingToolsResponse>(this.FUNDING_TOOLS_API_URL, { params });
                const fundingData = response.data?.data?.[0];

                const rawFunding = fundingData?.contract_1_total_funding || 0;

                if (isParadex) {
                    let correctedAnnualizedValue = rawFunding * 100;
                    const fundingPeriodHours = this.paradexMarketDataCache.get(item.coin);
                    if (fundingPeriodHours && fundingPeriodHours > 0) {
                        annualizedPercentage = (correctedAnnualizedValue * 8) / fundingPeriodHours;
                    } else {
                        annualizedPercentage = correctedAnnualizedValue;
                    }
                } else {
                    if (days > 0) {

                        annualizedPercentage = (rawFunding / days) * 365 * 100;
                    }
                }
            }

            if (!isHedged && item.side === 'LONG') {
                return -annualizedPercentage;
            }

            return annualizedPercentage;

        } catch (error) {
            console.error(`Failed to fetch funding for ${item.coin} for ${days} days:`, error);
            return 0;
        }
    }
}