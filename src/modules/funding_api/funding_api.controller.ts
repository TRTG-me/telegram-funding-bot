import { Context, Markup } from 'telegraf';
import { FundingApiService } from './funding_api.service';
import { FundingApiState } from './funding_api.types';

export class FundingApiController {
    private userState = new Map<number, FundingApiState & { scanSelected?: string[] }>();

    private readonly exchangeIcons: Record<string, string> = {
        'Binance': '',
        'Hyperliquid': '',
        'Paradex': '',
        'Lighter': '',
        'Extended': ''
    };

    constructor(private readonly fundingApiService: FundingApiService) { }

    private getExName(name: string): string {
        return `${this.exchangeIcons[name] || ''} ${name}`.trim();
    }

    public isUserInFlow(userId: number): boolean {
        const state = this.userState.get(userId);
        return !!state && (state.step === 'awaiting_coin' || state.step === 'selecting_exchanges');
    }

    public async handleFundingMenu(ctx: Context): Promise<void> {
        const keyboard = Markup.keyboard([
            ['Фандинги Поз', 'Окупаемость'],
            ['🔍 Фандинг монеты', '🏆 Лучшие монеты', '🔄 Обновить список монет', '🚀 Обновить БД'],
            ['🔙 Назад в меню']
        ]).resize();

        await ctx.reply('💎 <b>Аналитика Фандинга</b>\nВыберите раздел:', { parse_mode: 'HTML', ...keyboard });
    }

    // --- ЛУЧШИЕ МОНЕТЫ (СКАНЕР) ---

    public async handleBestOpportunities(ctx: Context): Promise<void> {
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🌐 Все биржи', 'fapi_scan_all')],
            [Markup.button.callback('⚙️ Ручной выбор', 'fapi_scan_manual')]
        ]);

        await ctx.reply('📊 Выберите режим сканирования:', keyboard);
    }

    private getScanKeyboard(selected: string[]) {
        const all = ['Binance', 'Hyperliquid', 'Paradex', 'Lighter', 'Extended'];
        const available = all.filter(ex => !selected.includes(ex));

        const buttons = available.map(ex => Markup.button.callback(ex, `fapi_scan_toggle_${ex}`));
        const rows: any[][] = [];
        if (buttons.length > 0) {
            for (let i = 0; i < buttons.length; i += 5) {
                rows.push(buttons.slice(i, i + 5));
            }
        }
        rows.push([Markup.button.callback('✅ ОК', 'fapi_scan_confirm')]);
        return Markup.inlineKeyboard(rows);
    }

    private async runScan(ctx: Context, selectedExchanges?: string[]) {
        try {
            await ctx.reply('⏳ Запускаю сканер лучших возможностей...\nЭто может занять 15-30 секунд.');
            const best = await this.fundingApiService.getBestOpportunities(selectedExchanges);

            if (!best || best.length === 0) {
                await ctx.reply('📭 На данный момент монет, подходящих под критерии фильтра, не найдено.');
                return;
            }

            const c0 = 14; // COIN (PAIR)
            const cW = 5;  // DATA

            let report = '💎 <b>ТОП МОНЕТЫ (APR %)</b>\n\n';
            let table = '<pre><code>';
            table += `┌${'─'.repeat(c0)}┬${'─'.repeat(cW)}┬${'─'.repeat(cW)}┬${'─'.repeat(cW)}┬${'─'.repeat(cW)}┬${'─'.repeat(cW)}┐\n`;
            table += `│${'COIN (P)'.padEnd(c0)}│${'8h'.padStart(cW)}│${'1d'.padStart(cW)}│${'3d'.padStart(cW)}│${'7d'.padStart(cW)}│${'14d'.padStart(cW)}│\n`;
            table += `├${'─'.repeat(c0)}┼${'─'.repeat(cW)}┼${'─'.repeat(cW)}┼${'─'.repeat(cW)}┼${'─'.repeat(cW)}┼${'─'.repeat(cW)}┤\n`;

            best.slice(0, 30).forEach(item => {
                const label = `${item.coin} (${item.pair})`.substring(0, c0).padEnd(c0);
                const diffs = item.diffs.map(v => v.toFixed(0).padStart(cW)).join('│');
                table += `│${label}│${diffs}│\n`;
            });

            table += `└${'─'.repeat(c0)}┴${'─'.repeat(cW)}┴${'─'.repeat(cW)}┴${'─'.repeat(cW)}┴${'─'.repeat(cW)}┴${'─'.repeat(cW)}┘\n`;
            table += '</code></pre>';

            report += table;
            report += '\n<i>*(P): Направление. Например H-B: Long HL / Short Binance</i>';

            await ctx.replyWithHTML(report);
        } catch (err: any) {
            await ctx.reply(`❌ Ошибка сканирования: ${err.message}`);
        }
    }

    // --- АНАЛИЗ МОНЕТЫ ---

    public async handleCoinAnalysisStart(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        this.userState.set(userId, { step: 'awaiting_coin', selectedExchanges: [], availableExchanges: [] });
        await ctx.reply('🔍 <b>Анализ монеты</b>\nВведите тикер монеты (напр. BTC, ETH):', { parse_mode: 'HTML' });
    }

    public async handleTextInput(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId || !ctx.message || !('text' in ctx.message)) return;

        const state = this.userState.get(userId);
        if (!state) return;

        if (state.step === 'awaiting_coin') {
            const coin = ctx.message.text.toUpperCase().trim();
            try {
                const info = await this.fundingApiService.getCoinAnalysis(coin);
                state.coin = coin;
                state.availableExchanges = info.availableExchanges;
                state.step = 'selecting_exchanges';

                await ctx.reply(`✅ Монета <b>${coin}</b> найдена на: ${info.availableExchanges.join(', ')}\nВыберите биржи для анализа:`, {
                    parse_mode: 'HTML',
                    ...this.getExchangesKeyboard(coin, info.availableExchanges, [])
                });
            } catch (err: any) {
                if (err.response?.status === 404) {
                    await ctx.reply(`❌ Монета <b>${coin}</b> не найдена в базе данных.`, { parse_mode: 'HTML' });
                } else {
                    await ctx.reply(`❌ Ошибка API: ${err.message}`);
                }
                this.userState.delete(userId);
            }
        }
    }

    private getExchangesKeyboard(coin: string, available: string[], selected: string[]) {
        const buttons = available
            .filter(ex => !selected.includes(ex))
            .map(ex => Markup.button.callback(ex, `fapi_sel_${ex}`));

        const rows: any[][] = [];
        if (buttons.length > 0) {
            for (let i = 0; i < buttons.length; i += 5) {
                rows.push(buttons.slice(i, i + 5));
            }
        }

        const actions = [];
        if (selected.length === 0) {
            actions.push(Markup.button.callback('🌐 Все сразу', `fapi_all`));
        } else {
            actions.push(Markup.button.callback('✅ ОК', `fapi_ok`));
        }
        rows.push(actions);

        return Markup.inlineKeyboard(rows);
    }

    public async handleCallbackQuery(ctx: Context): Promise<void> {
        if (!ctx.from || !ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
        const data = ctx.callbackQuery.data;
        if (!data.startsWith('fapi_')) return;

        try { await ctx.answerCbQuery(); } catch { }

        const userId = ctx.from.id;
        const state = this.userState.get(userId);

        if (data === 'fapi_scan_all') {
            await ctx.editMessageText('✅ Выбраны все биржи.');
            await this.runScan(ctx);
            return;
        }
        if (data === 'fapi_scan_manual') {
            this.userState.set(userId, { step: 'idle', selectedExchanges: [], availableExchanges: [], scanSelected: [] });
            await ctx.editMessageText('⚙️ Выберите биржи для сканирования и нажмите ОК:', this.getScanKeyboard([]));
            return;
        }
        if (data.startsWith('fapi_scan_toggle_')) {
            const ex = data.replace('fapi_scan_toggle_', '');
            const s = this.userState.get(userId);
            if (!s || !s.scanSelected) return;
            if (!s.scanSelected.includes(ex)) s.scanSelected.push(ex);

            if (s.scanSelected.length === 5) {
                await ctx.editMessageText('✅ Выбраны все биржи.');
                await this.runScan(ctx, s.scanSelected);
                this.userState.delete(userId);
            } else {
                await ctx.editMessageText(`Выбрано: ${s.scanSelected.join(', ')}\nВыберите еще или нажмите ОК:`, this.getScanKeyboard(s.scanSelected));
            }
            return;
        }
        if (data === 'fapi_scan_confirm') {
            const s = this.userState.get(userId);
            if (!s || !s.scanSelected || s.scanSelected.length === 0) return;
            await ctx.editMessageText(`✅ Запускаю расчет для: ${s.scanSelected.join(', ')}`);
            await this.runScan(ctx, s.scanSelected);
            this.userState.delete(userId);
            return;
        }

        if (!state || !state.coin) return;

        if (data === 'fapi_all') {
            await ctx.editMessageText(`⏳ Формирую отчеты для всех бирж (${state.coin})...`);
            await this.generateReport(ctx, state.coin, state.availableExchanges);
            this.userState.delete(userId);
        } else if (data === 'fapi_ok') {
            if (state.selectedExchanges.length === 0) return;
            await ctx.editMessageText(`⏳ Формирую отчеты для выбраных бирж...`);
            await this.generateReport(ctx, state.coin, state.selectedExchanges);
            this.userState.delete(userId);
        } else if (data.startsWith('fapi_sel_')) {
            const exchange = data.replace('fapi_sel_', '');
            if (!state.selectedExchanges.includes(exchange)) state.selectedExchanges.push(exchange);
            const list = state.selectedExchanges.join(', ');
            await ctx.editMessageText(`Выбрано: <b>${list}</b>\nВыберите еще или нажмите ОК:`, {
                parse_mode: 'HTML',
                ...this.getExchangesKeyboard(state.coin, state.availableExchanges, state.selectedExchanges)
            });
        }
    }

    private async generateReport(ctx: Context, coin: string, selected: string[] = []): Promise<void> {
        try {
            const data = await this.fundingApiService.getCoinAnalysis(coin, selected);
            const availableForCoin = data.availableExchanges;
            let pairs: [string, string][] = [];

            if (selected.length === 1) {
                const baseEx = selected[0];
                const others = availableForCoin.filter(ex => ex !== baseEx);
                others.forEach(other => pairs.push([baseEx, other]));
            } else {
                for (let i = 0; i < selected.length; i++) {
                    for (let j = i + 1; j < selected.length; j++) {
                        pairs.push([selected[i], selected[j]]);
                    }
                }
            }

            if (pairs.length === 0) {
                await ctx.reply(`📭 Монета ${coin} представлена только на одной бирже или недостаточно данных.`);
            }

            // Fetch live APRs
            const liveAPRs = new Map<string, number>();
            await Promise.all(selected.map(async (ex) => {
                const apr = await this.fundingApiService.getLiveFundingAPR(ex, coin);
                liveAPRs.set(ex, apr);
            }));

            for (const [ex1, ex2] of pairs) {
                const table = this.renderSingleComparisonTable(coin, data.comparisons, ex1, ex2, liveAPRs);
                if (table) {
                    await ctx.replyWithHTML(table);
                    await new Promise(r => setTimeout(r, 200));
                }
            }

            if (data.histories && data.histories.length > 0) {
                const participatingExchanges = new Set(pairs.flat());
                if (selected.length === 1) participatingExchanges.add(selected[0]);
                const filteredHistories = data.histories.filter(h => participatingExchanges.has(h.exchange));
                if (filteredHistories.length > 0) {
                    const chartBuffer = await this.fundingApiService.generateChart(coin, filteredHistories);
                    await ctx.replyWithPhoto({ source: chartBuffer });
                }
            }
        } catch (err: any) {
            await ctx.reply(`❌ Ошибка генерации отчета: ${err.message}`);
        }
    }

    private renderSingleComparisonTable(coin: string, comparisons: any[], ex1: string, ex2: string, liveAPRs: Map<string, number>): string | null {
        const comp = comparisons.find(c => c.pair.includes(ex1) && c.pair.includes(ex2));
        if (!comp) return null;
        const isEx1FirstValue = comp.pair.startsWith(ex1);
        const c0 = 8; const cW = 5;
        const formatVal = (val: number) => {
            if (val === null || val === undefined || isNaN(val)) return '  NaN'.padStart(cW);
            const s = val.toFixed(1); return (s.length > cW ? val.toFixed(0) : s).padStart(cW);
        };
        const live1 = liveAPRs.get(ex1) || 0;
        const live2 = liveAPRs.get(ex2) || 0;
        const liveDiff = live2 - live1;

        const top = `┌${'─'.repeat(c0)}┬${'─'.repeat(cW)}┬${'─'.repeat(cW)}┬${'─'.repeat(cW)}┬${'─'.repeat(cW)}┬${'─'.repeat(cW)}┬${'─'.repeat(cW)}┐\n`;
        const line = `├${'─'.repeat(c0)}┼${'─'.repeat(cW)}┼${'─'.repeat(cW)}┼${'─'.repeat(cW)}┼${'─'.repeat(cW)}┼${'─'.repeat(cW)}┼${'─'.repeat(cW)}┤\n`;
        const bottom = `└${'─'.repeat(c0)}┴${'─'.repeat(cW)}┴${'─'.repeat(cW)}┴${'─'.repeat(cW)}┴${'─'.repeat(cW)}┴${'─'.repeat(cW)}┴${'─'.repeat(cW)}┘\n`;

        const label1 = `${this.exchangeIcons[ex1] || ''}${ex1.substring(0, c0 - 2)}`.padEnd(c0);
        const label2 = `${this.exchangeIcons[ex2] || ''}${ex2.substring(0, c0 - 2)}`.padEnd(c0);

        let table = `📊 <b>${coin}</b>: ${this.exchangeIcons[ex1] || ''}${ex1} 🆚 ${this.exchangeIcons[ex2] || ''}${ex2}\n<pre><code>${top}│${'T-APR'.padEnd(c0)}│${'8h'.padStart(cW)}│${'1d'.padStart(cW)}│${'3d'.padStart(cW)}│${'7d'.padStart(cW)}│${'14d'.padStart(cW)}│${'cur'.padStart(cW)}│\n${line}`;
        const aprs1 = comp.results.map((r: any) => isEx1FirstValue ? r.apr1 : r.apr2);
        const aprs2 = comp.results.map((r: any) => isEx1FirstValue ? r.apr2 : r.apr1);
        const diffs = comp.results.map((r: any) => isEx1FirstValue ? -r.diff : r.diff);

        table += `│${label1}│${aprs1.map(formatVal).join('│')}│${formatVal(live1)}│\n`;
        table += `│${label2}│${aprs2.map(formatVal).join('│')}│${formatVal(live2)}│\n${line}│${'DIFF'.padEnd(c0)}│${diffs.map(formatVal).join('│')}│${formatVal(liveDiff)}│\n${bottom}</code></pre>`;
        return table;
    }

    // --- СИНХРОНИЗАЦИЯ ---

    public async handleSyncFull(ctx: Context): Promise<void> {
        try {
            await ctx.reply('🚀 <b>Запуск глобального обновления БД...</b>\nОпрашиваю 5 бирж параллельно.', { parse_mode: 'HTML' });
            const data = await this.fundingApiService.syncFull();

            if (data.success === false) {
                await ctx.reply(`⚠️ <b>Обновление отклонено:</b>\n${data.error || 'База уже обновляется другим пользователем.'}`, { parse_mode: 'HTML' });
                return;
            }

            let msg = `📊 <b>Отчет об обновлении:</b>\n\n`;
            if (data.report && Array.isArray(data.report)) {
                data.report.forEach((r: any) => {
                    const icon = this.exchangeIcons[r.label] || '';
                    if (r.success) {
                        msg += `✅ ${icon} <b>${r.label}</b>: ${r.totalSaved || 0} зап. за ${r.duration || 0}с\n`;
                    } else {
                        msg += `❌ ${icon} <b>${r.label}</b>: Ошибка\n`;
                    }
                });
            } else {
                msg += `ℹ️ Данные отчета не получены.\n`;
            }

            if (data.totalDuration) {
                msg += `\n🏁 <b>Всего затрачено:</b> ${data.totalDuration} сек.`;
            } else {
                msg += `\n🏁 Обновление завершено.`;
            }

            await ctx.replyWithHTML(msg);

        } catch (err: any) {
            if (err.response?.status === 409) {
                await ctx.reply(`⚠️ <b>Обновление уже запущено</b> другим пользователем. Пожалуйста, подождите завершения.`, { parse_mode: 'HTML' });
            } else {
                await ctx.reply(`❌ Ошибка обновления БД: ${err.message}`);
            }
        }
    }
    public async handleSyncCoins(ctx: Context): Promise<void> {
        try {
            const data = await this.fundingApiService.syncCoins();
            if (data.success) {
                await ctx.replyWithHTML(`✅ <b>[AutoSync] Список монет обновлен!</b>\nВсего активных пар: ${data.totalMatched}`);
            }
        } catch (err: any) {
            await ctx.reply(`❌ Ошибка обновления списка монет: ${err.message}`);
        }
    }
}
