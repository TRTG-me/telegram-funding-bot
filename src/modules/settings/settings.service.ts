import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { Settings } from './settings.types';

export class SettingsService {
    private readonly logger = new Logger(SettingsService.name);
    private readonly configPath = path.join(process.cwd(), 'settings.json');
    private settings!: Settings;

    constructor() {
        this.loadSettings();
    }

    private loadSettings() {
        try {
            if (fs.existsSync(this.configPath)) {
                const data = fs.readFileSync(this.configPath, 'utf8');
                this.settings = JSON.parse(data);
                this.logger.log('✅ Settings loaded successfully from settings.json');
            } else {
                this.logger.warn('⚠️ settings.json not found, using defaults.');
                this.settings = this.getDefaultSettings();
                this.saveSettings();
            }
        } catch (e: any) {
            this.logger.error('❌ Error loading settings.json:', e.message);
            this.settings = this.getDefaultSettings();
        }
    }

    public getSettings(): Settings {
        // Возвращаем копию, чтобы избежать случайных изменений
        return JSON.parse(JSON.stringify(this.settings));
    }

    public async updateSettings(newSettings: Settings): Promise<void> {
        this.settings = newSettings;
        await this.saveSettings();
    }

    private async saveSettings(): Promise<void> {
        try {
            fs.writeFileSync(this.configPath, JSON.stringify(this.settings, null, 2), 'utf8');
            this.logger.log('✅ Settings saved to settings.json');
        } catch (e: any) {
            this.logger.error('❌ Error saving settings.json:', e.message);
        }
    }

    private getDefaultSettings(): Settings {
        return {
            leverage: {
                green: { value: 5.0, emoji: '✅' },
                yellow: { value: 6.0, emoji: '☢️' },
                red: { value: 7.0, emoji: '🛑' }
            },
            adl: {
                target: 0.5,
                warn: 0.6,
                trigger: 0.7
            }
        };
    }
}
