import { Context, Markup } from 'telegraf';
import { FundingApiService } from './funding_api.service';
import { FundingApiState } from './funding_api.types';
import { PayBackService } from '../payback/payback.service';

export class FundingApiController {
    private userState = new Map<number, FundingApiState & { scanSelected?: string[] }>();
    private isScanning = false;

    private readonly exchangeIcons: Record<string, string> = {
        'Binance': '',
        'Hyperliquid': '',
        'Paradex': '',
        'Lighter': '',
        'Extended': ''
    };

    constructor(
        private readonly fundingApiService: FundingApiService,
        private readonly payBackService: PayBackService
    ) { }

    private getExName(name: string): string {
        return `${this.exchangeIcons[name] || ''} ${name}`.trim();
    }

    public isUserInFlow(userId: number): boolean {
        const state = this.userState.get(userId);
        return !!state && (state.step === 'awaiting_coin' || state.step === 'selecting_exchanges' || state.step === 'editing_preset');
    }

    public async handleFundingMenu(ctx: Context): Promise<void> {
        const keyboard = Markup.keyboard([
            ['Фандинги Поз', '🏆 Лучшие монеты'],
            ['🔍 Фандинг монеты', '🔍 Окупаемость монеты'],
            ['⚙️ Настройки', '🔙 Назад в меню']
        ]).resize();

        await ctx.reply('Меню фандинга и анализа:', keyboard);
    }

    // --- ЛУЧШИЕ МОНЕТЫ (СКАНЕР) ---

    public async handleBestOpportunities(ctx: Context): Promise<void> {
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🌐 Все биржи', 'fapi_scan_mode_all')],
            [Markup.button.callback('⚙️ Ручной выбор', 'fapi_scan_mode_manual')]
        ]);

        await ctx.reply('📊 Выберите режим сканирования:', keyboard);
    }

    private async showPresetSelection(ctx: Context, mode: 'all' | 'manual') {
        const presets = await this.fundingApiService.getPresets();

        let text = `🎯 <b>ВЫБОР ФИЛЬТРА (${mode === 'all' ? 'Все биржи' : 'Ручной выбор'})</b>\n\n`;
        text += '<pre><code>';
        text += `| P | 8h | 1d | 3d | 7d | 14d |\n`;
        text += `|---|----|----|----|----|-----|\n`;
        for (const p of presets) {
            const num = p.name.substring(7);
            text += `| ${num} | ${p.h8.toString().padStart(2)} | ${p.d1.toString().padStart(2)} | ${p.d3.toString().padStart(2)} | ${p.d7.toString().padStart(2)} | ${p.d14.toString().padStart(3)} |\n`;
        }
        text += '</code></pre>\n';
        text += 'Выберите кнопку соответствующего пресета:';

        const buttons = presets.map(p => Markup.button.callback(p.name.substring(7), `fapi_scan_preset_${p.id}_${mode}`));
        const keyboard = Markup.inlineKeyboard([buttons]);

        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
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

    private async runScan(ctx: Context, presetId: number, selectedExchanges?: string[]) {
        if (this.isScanning) {
            await ctx.reply('⚠️ Сканер уже работает. Пожалуйста, подождите.');
            return;
        }
        let waitMsg: any = null;
        try {
            this.isScanning = true;
            const userId = ctx.from!.id;
            waitMsg = await ctx.reply('⏳ Запускаю сканер лучших возможностей...\nЭто может занять 15-30 секунд.');

            const best = await this.fundingApiService.getBestOpportunities(selectedExchanges, presetId);

            if (waitMsg) {
                await ctx.deleteMessage(waitMsg.message_id).catch(() => { });
            }

            if (!best || best.length === 0) {
                await ctx.reply('📭 На данный момент монет, подходящих под критерии фильтра, не найдено.');
                return;
            }

            // Инициализируем состояние пагинации
            this.userState.set(userId, {
                step: 'idle',
                selectedExchanges: [],
                availableExchanges: [],
                scanResults: best,
                scanPage: 0
            });

            await this.displayScanPage(ctx, userId, 0);
        } catch (err: any) {
            if (waitMsg) {
                await ctx.deleteMessage(waitMsg.message_id).catch(() => { });
            }
            await ctx.reply(`❌ Ошибка сканирования: ${err.message}`);
        } finally {
            this.isScanning = false;
        }
    }

    private async displayScanPage(ctx: Context, userId: number, page: number) {
        const state = this.userState.get(userId);
        if (!state || !state.scanResults) return;

        const pageSize = 15;
        const total = state.scanResults.length;
        const totalPages = Math.ceil(total / pageSize);
        const start = page * pageSize;
        const end = Math.min(start + pageSize, total);
        const items = state.scanResults.slice(start, end);

        const c0 = 14; // COIN (PAIR)
        const cW = 5;  // DATA

        let report = `💎 <b>ТОП МОНЕТЫ (APR %)</b>\n`;
        report += `Страница ${page + 1} (${start + 1}-${end} из ${total})\n\n`;
        let table = '<pre><code>';
        table += `┌${'─'.repeat(c0)}┬${'─'.repeat(cW)}┬${'─'.repeat(cW)}┬${'─'.repeat(cW)}┬${'─'.repeat(cW)}┬${'─'.repeat(cW)}┐\n`;
        table += `│${'COIN (P)'.padEnd(c0)}│${'8h'.padStart(cW)}│${'1d'.padStart(cW)}│${'3d'.padStart(cW)}│${'7d'.padStart(cW)}│${'14d'.padStart(cW)}│\n`;
        table += `├${'─'.repeat(c0)}┼${'─'.repeat(cW)}┼${'─'.repeat(cW)}┼${'─'.repeat(cW)}┼${'─'.repeat(cW)}┼${'─'.repeat(cW)}┤\n`;

        items.forEach(item => {
            const label = `${item.coin} (${item.pair})`.substring(0, c0).padEnd(c0);
            const diffs = item.diffs.map(v => v.toFixed(0).padStart(cW)).join('│');
            table += `│${label}│${diffs}│\n`;
        });

        table += `└${'─'.repeat(c0)}┴${'─'.repeat(cW)}┴${'─'.repeat(cW)}┴${'─'.repeat(cW)}┴${'─'.repeat(cW)}┴${'─'.repeat(cW)}┘\n`;
        table += '</code></pre>';
        report += table;
        report += '\n<i>*(P): Направление. Например H-B: Long HL / Short Binance</i>';

        const navButtons = [];
        if (page > 0) navButtons.push(Markup.button.callback('⬅️ Назад', `fapi_scan_page_prev`));
        if (page < totalPages - 1) navButtons.push(Markup.button.callback('Вперед ➡️', `fapi_scan_page_next`));

        const keyboard = Markup.inlineKeyboard([
            navButtons,
            [Markup.button.callback('📊 Окупаемость страницы', 'fapi_page_payback')]
        ]);

        if (ctx.callbackQuery) {
            await ctx.editMessageText(report, { parse_mode: 'HTML', ...keyboard });
        } else {
            await ctx.replyWithHTML(report, keyboard);
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
        } else if (state.step === 'editing_preset' && state.editingPresetId) {
            const text = ctx.message.text.trim();
            const vals = text.split(/[,\s]+/).map((v: string) => parseFloat(v));
            if (vals.length === 5 && vals.every((v: number) => !isNaN(v))) {
                try {
                    await this.fundingApiService.updatePreset(state.editingPresetId, {
                        h8: vals[0], d1: vals[1], d3: vals[2], d7: vals[3], d14: vals[4]
                    });
                    await ctx.reply(`✅ Пресет ${state.editingPresetId} обновлен!`);
                    this.userState.delete(userId);
                    await this.showFundingSettings(ctx);
                } catch (err: any) {
                    await ctx.reply(`❌ Ошибка сохранения: ${err.message}`);
                }
            } else {
                await ctx.reply('❌ Некорректный формат. Нужно 5 чисел через запятую или пробел.\nПример: 30, 30, 25, 25, 20');
            }
            return;
        }

        // --- Массовое редактирование через таблицу ---
        const text = ctx.message.text.trim();
        if (text.includes('| P |') && text.includes('| 8h |')) {
            this.userState.set(userId, { step: 'idle', selectedExchanges: [], availableExchanges: [], candidateText: text });
            await ctx.reply('📥 Данные всей таблицы получены. Нажмите "✅ Сохранить таблицу" в меню настроек выше для применения.');
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

        if (data === 'fapi_scan_mode_all') {
            await this.showPresetSelection(ctx, 'all');
            return;
        }
        if (data === 'fapi_scan_mode_manual') {
            this.userState.set(userId, { step: 'idle', selectedExchanges: [], availableExchanges: [], scanSelected: [] });
            await ctx.editMessageText('⚙️ Выберите биржи для сканирования и нажмите ОК:', this.getScanKeyboard([]));
            return;
        }
        if (data.startsWith('fapi_scan_preset_')) {
            const parts = data.split('_');
            const presetId = parseInt(parts[3]);
            const scanMode = parts[4];

            if (scanMode === 'all') {
                await this.runScan(ctx, presetId);
            } else {
                const s = this.userState.get(userId);
                if (s && s.scanSelected) {
                    await this.runScan(ctx, presetId, s.scanSelected);
                }
            }
            return;
        }
        if (data === 'fapi_scan_page_prev') {
            const s = this.userState.get(userId);
            if (s && s.scanResults && s.scanPage !== undefined && s.scanPage > 0) {
                s.scanPage--;
                await this.displayScanPage(ctx, userId, s.scanPage);
            }
            await ctx.answerCbQuery();
            return;
        }
        if (data === 'fapi_scan_page_next') {
            const s = this.userState.get(userId);
            if (s && s.scanResults && s.scanPage !== undefined) {
                const pageSize = 10;
                const totalPages = Math.ceil(s.scanResults.length / pageSize);
                if (s.scanPage < totalPages - 1) {
                    s.scanPage++;
                    await this.displayScanPage(ctx, userId, s.scanPage);
                }
            }
            await ctx.answerCbQuery();
            return;
        }
        if (data === 'fapi_page_payback') {
            await this.handlePagePayback(ctx, userId);
            await ctx.answerCbQuery();
            return;
        }
        if (data.startsWith('fapi_scan_toggle_')) {
            const ex = data.replace('fapi_scan_toggle_', '');
            const s = this.userState.get(userId);
            if (!s || !s.scanSelected) return;
            if (!s.scanSelected.includes(ex)) s.scanSelected.push(ex);

            if (s.scanSelected.length === 5) {
                await this.showPresetSelection(ctx, 'manual');
            } else {
                await ctx.editMessageText(`Выбрано: ${s.scanSelected.join(', ')}\nВыберите еще или нажмите ОК:`, this.getScanKeyboard(s.scanSelected));
            }
            return;
        }
        if (data === 'fapi_scan_confirm') {
            const s = this.userState.get(userId);
            if (!s || !s.scanSelected || s.scanSelected.length === 0) return;
            await this.showPresetSelection(ctx, 'manual');
            return;
        }

        if (data.startsWith('fapi_settings_edit_')) {
            const id = parseInt(data.replace('fapi_settings_edit_', ''));
            this.userState.set(userId, { step: 'editing_preset', editingPresetId: id, selectedExchanges: [], availableExchanges: [] });
            await ctx.reply(`✏️ Редактируем <b>Пресет ${id}</b>\nВведите 5 новых значений через запятую (8h, 1d, 3d, 7d, 14d):`, { parse_mode: 'HTML' });
            return;
        }

        if (data === 'fapi_settings_close') {
            await ctx.deleteMessage().catch(() => { });
            this.userState.delete(userId);
            return;
        }

        if (data === 'fapi_settings_save') {
            const s = this.userState.get(userId);
            if (!s || !s.candidateText) {
                await ctx.answerCbQuery('⚠️ Сначала отправьте отредактированную таблицу текстом!', { show_alert: true });
                return;
            }

            try {
                const lines = s.candidateText.split('\n').filter(l => l.includes('|') && !l.includes('8h') && !l.includes('--'));
                const dbPresets = await this.fundingApiService.getPresets();

                for (const line of lines) {
                    const cells = line.split('|').map(c => c.trim()).filter(c => c.length > 0);
                    if (cells.length < 6) continue;

                    const num = cells[0]; // Напр. "1"
                    const h8 = parseFloat(cells[1]);
                    const d1 = parseFloat(cells[2]);
                    const d3 = parseFloat(cells[3]);
                    const d7 = parseFloat(cells[4]);
                    const d14 = parseFloat(cells[5]);

                    const existing = dbPresets.find(p => p.name.endsWith(num));
                    if (existing) {
                        await this.fundingApiService.updatePreset(existing.id, { h8, d1, d3, d7, d14 });
                    }
                }

                await ctx.editMessageText('✅ Все настройки успешно сохранены!');
                this.userState.delete(userId);
            } catch (e: any) {
                await ctx.reply('❌ Ошибка парсинга или сохранения: ' + e.message);
            }
            await ctx.answerCbQuery();
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

    public async handleFundingSettings(ctx: Context): Promise<void> {
        await this.showFundingSettings(ctx);
    }

    private async showFundingSettings(ctx: Context) {
        const userId = ctx.from!.id;
        const presets = await this.fundingApiService.getPresets();

        let text = '⚙️ <b>НАСТРОЙКИ ПОРОГОВ (APR %)</b>\n\n';
        text += '<pre><code>';
        text += `| P | 8h | 1d | 3d | 7d | 14d |\n`;
        text += `|---|----|----|----|----|-----|\n`;
        for (const p of presets) {
            const num = p.name.substring(7);
            text += `| ${num} | ${p.h8.toString().padStart(2)} | ${p.d1.toString().padStart(2)} | ${p.d3.toString().padStart(2)} | ${p.d7.toString().padStart(2)} | ${p.d14.toString().padStart(3)} |\n`;
        }
        text += '</code></pre>\n';
        text += '💡 <b>Как изменить?</b>\n';
        text += 'Нажмите кнопку нужного пресета ниже и введите 5 чисел через запятую.';

        const pButtons = presets.map(p => Markup.button.callback(p.name.substring(7), `fapi_settings_edit_${p.id}`));
        const keyboard = Markup.inlineKeyboard([
            pButtons,
            [Markup.button.callback('✅ Сохранить таблицу', 'fapi_settings_save')],
            [Markup.button.callback('❌ Закрыть', 'fapi_settings_close')]
        ]);

        if (ctx.callbackQuery) {
            await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
        } else {
            await ctx.replyWithHTML(text, keyboard);
        }
        this.userState.delete(userId);
    }
    private async handlePagePayback(ctx: Context, userId: number) {
        const s = this.userState.get(userId);
        if (!s || !s.scanResults || s.scanPage === undefined) {
            return ctx.reply('⚠️ Сессия истекла или данные не найдены.');
        }

        const pageSize = 10;
        const pageItems = s.scanResults.slice(s.scanPage * pageSize, (s.scanPage + 1) * pageSize);

        if (this.payBackService.isSessionActive(userId)) {
            return ctx.reply('⚠️ Уже запущен расчет окупаемости. Дождитесь завершения.');
        }

        const msg = await ctx.reply(`🚀 <b>Запускаю расчет окупаемости для ${pageItems.length} монет...</b>\nЭто займет около 60 секунд.\n\n⏳ Пожалуйста, подождите...`, { parse_mode: 'HTML' });

        try {
            await this.payBackService.startPagePayback(
                userId,
                pageItems,
                `📊 <b>ОКУПАЕМОСТЬ (Стр. ${s.scanPage + 1})</b>`,
                async (result) => {
                    await ctx.deleteMessage(msg.message_id).catch(() => { });
                    await ctx.telegram.sendMessage(userId, result, { parse_mode: 'HTML' });
                }
            );
        } catch (err: any) {
            await ctx.deleteMessage(msg.message_id).catch(() => { });
            await ctx.reply(`❌ Ошибка расчета: ${err.message}`);
        }
    }
}
