import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { ChartConfiguration } from 'chart.js';
import { BestOpportunity, CoinAnalysisResponse } from './funding_api.types';

@Injectable()
export class FundingApiService {
    private readonly logger = new Logger(FundingApiService.name);
    private readonly API_BASE = 'http://localhost:3000/api';
    private chartJSNodeCanvas: ChartJSNodeCanvas;

    constructor() {
        this.chartJSNodeCanvas = new ChartJSNodeCanvas({
            width: 1000,
            height: 500,
            backgroundColour: 'white'
        });
    }

    async getCoins(): Promise<string[]> {
        const resp = await axios.get(`${this.API_BASE}/coins`);
        return resp.data.coins;
    }

    async getBestOpportunities(exchanges?: string[]): Promise<BestOpportunity[]> {
        const params = exchanges ? { exchanges: exchanges.join(',') } : {};
        const resp = await axios.get(`${this.API_BASE}/best-opportunities`, { params });
        return resp.data.data;
    }

    async getCoinAnalysis(coin: string, exchanges?: string[]): Promise<CoinAnalysisResponse> {
        const params = exchanges ? { exchanges: exchanges.join(',') } : {};
        const resp = await axios.get(`${this.API_BASE}/coin/${coin}`, { params });
        return resp.data;
    }

    async syncFull(): Promise<any> {
        const resp = await axios.post(`${this.API_BASE}/sync/full`, {}, { timeout: 120000 });
        return resp.data;
    }

    async syncCoins(): Promise<any> {
        const resp = await axios.post(`${this.API_BASE}/sync/coins`, {}, { timeout: 60000 });
        return resp.data;
    }

    async generateChart(coin: string, histories: { exchange: string, history: any[] }[]): Promise<Buffer> {
        const colorMap: Record<string, string> = {
            'Binance': 'rgb(33, 150, 243)',
            'Hyperliquid': 'rgb(244, 67, 54)',
            'Paradex': 'rgb(76, 175, 80)',
            'Lighter': 'rgb(156, 39, 176)',
            'Extended': 'rgb(255, 152, 0)'
        };

        const allTimesSet = new Set<number>();
        histories.forEach(h => h.history.forEach(p => allTimesSet.add(Number(p.date))));
        const allTimes = Array.from(allTimesSet).sort((a, b) => a - b);

        if (allTimes.length === 0) {
            return await this.chartJSNodeCanvas.renderToBuffer({
                type: 'line',
                data: { labels: ['No Data'], datasets: [] },
                options: { plugins: { title: { display: true, text: `No historical data for ${coin}` } } }
            } as any);
        }

        const labels = allTimes.map(t => {
            const d = new Date(t);
            return `${d.getDate()}.${d.getMonth() + 1} ${d.getHours()}:00`;
        });

        const datasets = histories.map(ds => {
            const historyMap = new Map(ds.history.map(h => [Number(h.date), h.rate]));
            return {
                label: ds.exchange,
                data: allTimes.map(t => {
                    const val = historyMap.get(t);
                    return val !== undefined ? parseFloat(val.toFixed(2)) : null;
                }),
                borderColor: colorMap[ds.exchange] || '#000',
                backgroundColor: (colorMap[ds.exchange] || '#000').replace('rgb', 'rgba').replace(')', ', 0.1)'),
                borderWidth: 2,
                pointRadius: 0,
                tension: 0.4,
                spanGaps: true
            };
        });

        const configuration: ChartConfiguration = {
            type: 'line',
            data: { labels, datasets: datasets as any[] },
            options: {
                responsive: false,
                animation: false,
                plugins: {
                    title: { display: true, text: `${coin} Funding APR % (14 days)`, font: { size: 20 } },
                    legend: { position: 'bottom' }
                },
                scales: {
                    x: {
                        ticks: {
                            maxTicksLimit: 14,
                            callback: function (val, index) {
                                const label = this.getLabelForValue(index as number);
                                return label.split(' ')[0];
                            }
                        }
                    },
                    y: { ticks: { callback: (value) => value + '%' } }
                }
            }
        };

        return await this.chartJSNodeCanvas.renderToBuffer(configuration as any);
    }
}
