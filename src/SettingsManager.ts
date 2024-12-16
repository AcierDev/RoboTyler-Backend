import fs from "fs/promises";
import path from "path";
import chalk from "chalk";
import { SystemSettings } from "./types.js";

const DEFAULT_SETTINGS: SystemSettings = {
  speeds: {
    front: 100,
    right: 100,
    back: 100,
    left: 100,
  },
  maintenance: {
    lastMaintenanceDate: new Date().toISOString().split("T")[0],
    maintenanceInterval: 30,
    primeTime: 5,
    cleanTime: 10,
  },
  serial: {
    baudRate: 115200,
    vendorIds: [
      "2341", // Arduino vendor ID
      "1a86", // CH340 chip vendor ID
    ],
  },
  pattern: {
    initialOffsets: {
      front: { x: 0, y: 0 },
      right: { x: 0, y: 0 },
      back: { x: 0, y: 0 },
      left: { x: 0, y: 0 },
    },
    travelDistance: {
      horizontal: { x: 10, y: 0 },
      vertical: { x: 10, y: 2 },
    },
    rows: {
      x: 6,
      y: 8,
    },
  },
};

export class SettingsManager {
  private static instance: SettingsManager;
  private settings: SystemSettings;
  private readonly settingsPath: string;

  private constructor() {
    this.settingsPath = path.join(process.cwd(), "settings.json");
    this.settings = DEFAULT_SETTINGS;
  }

  static getInstance(): SettingsManager {
    if (!SettingsManager.instance) {
      SettingsManager.instance = new SettingsManager();
    }
    return SettingsManager.instance;
  }

  async initialize(): Promise<void> {
    try {
      const data = await fs.readFile(this.settingsPath, "utf-8");
      this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
      console.log(chalk.green("✓ Settings loaded successfully"));
    } catch (error) {
      console.log(
        chalk.yellow("⚠ No settings file found, creating with defaults...")
      );
      await this.saveSettings();
    }
  }

  private async saveSettings(): Promise<void> {
    try {
      await fs.writeFile(
        this.settingsPath,
        JSON.stringify(this.settings, null, 2),
        "utf-8"
      );
      console.log(chalk.green("✓ Settings saved successfully"));
    } catch (error) {
      console.error(chalk.red("❌ Error saving settings:"), error);
      throw error;
    }
  }

  async updateSpeeds(speeds: Partial<SystemSettings["speeds"]>): Promise<void> {
    this.settings.speeds = { ...this.settings.speeds, ...speeds };
    await this.saveSettings();
  }

  async updateMaintenanceDate(): Promise<void> {
    this.settings.maintenance.lastMaintenanceDate = new Date()
      .toISOString()
      .split("T")[0];
    await this.saveSettings();
  }

  async updateMaintenanceSettings(
    settings: Partial<SystemSettings["maintenance"]>
  ): Promise<void> {
    this.settings.maintenance = { ...this.settings.maintenance, ...settings };
    await this.saveSettings();
  }

  async updatePatternSettings(
    settings: Partial<SystemSettings["pattern"]>
  ): Promise<void> {
    this.settings.pattern = { ...this.settings.pattern, ...settings };
    await this.saveSettings();
  }

  getSettings(): SystemSettings {
    return { ...this.settings };
  }

  getSpeeds(): SystemSettings["speeds"] {
    return { ...this.settings.speeds };
  }

  getSerialConfig() {
    return { ...this.settings.serial };
  }

  getMaintenanceSettings() {
    return { ...this.settings.maintenance };
  }

  getPatternSettings() {
    return { ...this.settings.pattern };
  }
}
