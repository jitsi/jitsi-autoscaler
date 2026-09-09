import OracleInstanceManager from './oracle_instance_manager';
import CustomInstanceManager from './custom_instance_manager';
import NomadInstanceManager from './nomad_instance_manager';
import DigitalOceanInstanceManager from './digital_ocean_instance_manager';
import { CloudInstanceManager, DEFAULT_CLOUD_PROVIDER_REQUEST_TIMEOUT_MS } from './cloud_instance_manager';

export interface CloudInstanceManagerSelectorOptions {
    cloudProviders: string[];
    isDryRun: boolean;
    ociConfigurationFilePath: string;
    ociConfigurationProfile: string;

    digitalOceanAPIToken: string;
    digitalOceanConfigurationFilePath: string;

    customConfigurationLaunchScriptPath: string;
    customConfigurationLaunchScriptTimeoutMs: number;
    // optional script listing the instances of a group, see custom_instance_manager.ts
    customConfigurationListScriptPath?: string;

    // per-request HTTP timeout applied to every cloud provider API call
    cloudProviderRequestTimeoutMs?: number;
}

export class CloudInstanceManagerSelector {
    private oracleInstanceManager: OracleInstanceManager;
    private digitalOceanInstanceManager: DigitalOceanInstanceManager;
    private customInstanceManager: CustomInstanceManager;
    private nomadInstanceManager: NomadInstanceManager;

    constructor(options: CloudInstanceManagerSelectorOptions) {
        const cloudProviderRequestTimeoutMs =
            options.cloudProviderRequestTimeoutMs ?? DEFAULT_CLOUD_PROVIDER_REQUEST_TIMEOUT_MS;

        if (options.cloudProviders.includes('oracle')) {
            this.oracleInstanceManager = new OracleInstanceManager({
                isDryRun: options.isDryRun,
                ociConfigurationFilePath: options.ociConfigurationFilePath,
                ociConfigurationProfile: options.ociConfigurationProfile,
                cloudProviderRequestTimeoutMs,
            });
        }

        if (options.cloudProviders.includes('custom')) {
            this.customInstanceManager = new CustomInstanceManager({
                isDryRun: options.isDryRun,
                customConfigurationLaunchScriptPath: options.customConfigurationLaunchScriptPath,
                customConfigurationLaunchScriptTimeoutMs: options.customConfigurationLaunchScriptTimeoutMs,
                customConfigurationListScriptPath: options.customConfigurationListScriptPath,
            });
        }
        if (options.cloudProviders.includes('digitalocean')) {
            this.digitalOceanInstanceManager = new DigitalOceanInstanceManager({
                isDryRun: options.isDryRun,
                digitalOceanAPIToken: options.digitalOceanAPIToken,
                digitalOceanConfigurationFilePath: options.digitalOceanConfigurationFilePath,
                cloudProviderRequestTimeoutMs,
            });
        }
        if (options.cloudProviders.includes('nomad')) {
            this.nomadInstanceManager = new NomadInstanceManager({
                isDryRun: options.isDryRun,
                cloudProviderRequestTimeoutMs,
            });
        }
    }

    selectInstanceManager(cloud: string): CloudInstanceManager {
        switch (cloud) {
            case 'oracle':
                return this.oracleInstanceManager;
            case 'digitalocean':
                return this.digitalOceanInstanceManager;
            case 'nomad':
                return this.nomadInstanceManager;
            case 'custom':
                return this.customInstanceManager;
            default:
                return null;
        }
    }
}
