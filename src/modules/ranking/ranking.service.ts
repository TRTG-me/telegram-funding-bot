import { promises as fs } from 'fs';
import * as path from 'path';

export interface Rank {
    min: number;
    max: number;
    emoji: string;
}

export class RankingService {
    private readonly configPath = path.resolve(process.cwd(), 'ranking-config.json');
    private ranks: Rank[] = [];
    private defaultEmoji = '🤔';

    constructor() {
        this.loadConfig().catch(err => console.error('Failed to load initial ranking config:', err));
    }

    private async loadConfig(): Promise<void> {
        const fileContent = await fs.readFile(this.configPath, 'utf-8');
        this.ranks = JSON.parse(fileContent);
    }

    public getEmojiForLeverage(leverage: number): string {
        const rank = this.ranks.find(r => leverage >= r.min && leverage < r.max);
        return rank ? rank.emoji : this.defaultEmoji;
    }

    public async getConfig(): Promise<Rank[]> {
        await this.loadConfig(); // Перечитываем на случай ручных изменений
        return this.ranks;
    }

    public async updateConfig(newRanks: Rank[]): Promise<void> {
        if (!Array.isArray(newRanks) || newRanks.some(r => typeof r.min !== 'number' || typeof r.max !== 'number' || typeof r.emoji !== 'string')) {
            throw new Error('Invalid rank configuration format.');
        }
        await fs.writeFile(this.configPath, JSON.stringify(newRanks, null, 2), 'utf-8');
        await this.loadConfig();
    }
}