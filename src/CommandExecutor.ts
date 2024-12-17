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

interface SerialConfig {
  path: string;
  baudRate: number;
}

export class CommandExecutor {
  static async findUSBDevice(): Promise<string> {
    const settings = SettingsManager.getInstance();
    const { vendorIds } = settings.getSerialConfig();

    try {
      console.log(chalk.blue("🔍 Scanning for USB devices..."));
      console.log(chalk.gray("Looking for vendor IDs:"), vendorIds);

      const ports = await SerialPort.list();

      // Enhanced debugging output
      console.log(chalk.gray("Found devices:"));
      ports.forEach((port) => {
        const vendorId = port.vendorId?.toLowerCase();
        const isCompatible = vendorId && vendorIds.includes(vendorId);

        const vendorStatus = vendorId
          ? isCompatible
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
          port.vendorId?.toLowerCase() &&
          vendorIds.includes(port.vendorId.toLowerCase())
      );

      if (compatibleDevices.length > 0) {
        const selectedDevice = compatibleDevices[0];
        console.log(
          chalk.green("\n✓ Selected device:"),
          chalk.bold(selectedDevice.path),
          chalk.gray(
            `(VID: ${selectedDevice.vendorId}, PID: ${selectedDevice.productId})`
          )
        );
        return selectedDevice.path;
      }

      // Only try common paths if no compatible devices found
      console.log(
        chalk.yellow("\nNo devices found by vendor ID, trying common paths...")
      );
      const commonPaths = [
        "/dev/ttyUSB0",
        "/dev/ttyUSB1",
        "/dev/ttyACM0",
        "/dev/ttyACM1",
        "/dev/tty.usbserial-210",
      ];

      for (const path of commonPaths) {
        try {
          const testPort = new SerialPort({ path, baudRate: 115200 });
          await new Promise((resolve) => testPort.close(resolve));
          console.log(chalk.green(`Found device at ${path}`));
          return path;
        } catch (e) {
          // Path not available, continue to next
          continue;
        }
      }

      throw new Error(
        "No compatible USB devices found. Please check the connection."
      );
    } catch (error) {
      console.error(chalk.red("❌ Error scanning USB devices:"), error);
      throw error;
    }
  }

  static async getSerialConfig(): Promise<SerialConfig> {
    const settings = SettingsManager.getInstance();
    const { baudRate } = settings.getSerialConfig();
    const path = await this.findUSBDevice();
    return { path, baudRate };
  }
}
