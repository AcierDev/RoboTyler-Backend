import { SerialPort } from "serialport";
import chalk from "chalk";
import { SettingsManager } from "./SettingsManager.js";

interface USBDevice {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  productId?: string;
  vendorId?: string;
  pnpId?: string;
}

export class CommandExecutor {
  static async findUSBDevice(): Promise<string> {
    const settings = SettingsManager.getInstance();
    const { vendorIds } = settings.getSerialConfig();

    try {
      console.log(chalk.blue("🔍 Scanning for USB devices..."));
      const ports = await SerialPort.list();

      // Enhanced debugging output
      console.log(chalk.gray("Found devices:"));
      ports.forEach((port) => {
        const vendorStatus = port.vendorId
          ? vendorIds.includes(port.vendorId.toLowerCase())
            ? chalk.green("✓ Compatible")
            : chalk.yellow("✗ Incompatible")
          : chalk.red("No vendor ID");

        console.log(
          chalk.gray("└─"),
          chalk.bold(port.path),
          vendorStatus,
          chalk.gray(
            `(VID: ${port.vendorId || "unknown"}, PID: ${
              port.productId || "unknown"
            })`
          )
        );
      });

      // Filter for devices with matching vendor IDs
      const compatibleDevices = ports.filter(
        (port) =>
          port.vendorId && vendorIds.includes(port.vendorId.toLowerCase())
      );

      if (compatibleDevices.length === 0) {
        console.log(
          chalk.yellow("\nSupported vendor IDs:"),
          vendorIds.join(", ")
        );
        throw new Error(
          "No compatible USB devices found. Please check the connection."
        );
      }

      if (compatibleDevices.length > 1) {
        console.log(
          chalk.yellow(
            "⚠️  Multiple compatible devices found. Using first device."
          )
        );
      }

      const selectedDevice = compatibleDevices[0];
      console.log(
        chalk.green("\n✓ Selected device:"),
        chalk.bold(selectedDevice.path),
        chalk.gray(
          `(VID: ${selectedDevice.vendorId}, PID: ${selectedDevice.productId})`
        )
      );

      return selectedDevice.path;
    } catch (error) {
      console.error(chalk.red("❌ Error scanning USB devices:"), error);
      throw error;
    }
  }

  static async getSerialConfig(): Promise<{ path: string; baudRate: number }> {
    const settings = SettingsManager.getInstance();
    const { baudRate } = settings.getSerialConfig();
    const path = await this.findUSBDevice();
    return { path, baudRate };
  }
}
