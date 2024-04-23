import OracleInstanceManager from './oracle_instance_manager';
import CustomInstanceManager from './custom_instance_manager';
import NomadInstanceManager from './nomad_instance_manager';
import DigitalOceanInstanceManager from './digital_ocean_instance_manager';
import { CloudInstanceManager } from './cloud_instance_manager';
import OracleInstancePoolManager from './oracle_instance_pool_manager';
import { InstanceTracker } from './instance_tracker';

export interface CloudInstanceManagerSelectorOptions {
    cloudProviders: string[];
    instanceTracker: InstanceTracker;
    isDryRun: boolean;
    ociConfigurationFilePath: string;
    ociConfigurationProfile: string;

    digitalOceanAPIToken: string;
    digitalOceanConfigurationFilePath: string;

    customConfigurationLaunchScriptPath: string;
    customConfigurationLaunchScriptTimeoutMs: number;
}

export class CloudInstanceManagerSelector {
    private oracleInstanceManager: OracleInstanceManager;
    private oracleInstancePoolManager: OracleInstancePoolManager;
    private digitalOceanInstanceManager: DigitalOceanInstanceManager;
    private customInstanceManager: CustomInstanceManager;
    private nomadInstanceManager: NomadInstanceManager;

    constructor(options: CloudInstanceManagerSelectorOptions) {
        if (options.cloudProviders.includes('oracle')) {
            this.oracleInstanceManager = new OracleInstanceManager({
                isDryRun: options.isDryRun,
                ociConfigurationFilePath: options.ociConfigurationFilePath,
                ociConfigurationProfile: options.ociConfigurationProfile,
            });
        }

        if (options.cloudProviders.includes('oraclepool')) {
            this.oracleInstancePoolManager = new OracleInstancePoolManager({
                isDryRun: options.isDryRun,
                instanceTracker: options.instanceTracker,
                ociConfigurationFilePath: options.ociConfigurationFilePath,
                ociConfigurationProfile: options.ociConfigurationProfile,
            });
        }

        if (options.cloudProviders.includes('custom')) {
            this.customInstanceManager = new CustomInstanceManager({
                isDryRun: options.isDryRun,
                customConfigurationLaunchScriptPath: options.customConfigurationLaunchScriptPath,
                customConfigurationLaunchScriptTimeoutMs: options.customConfigurationLaunchScriptTimeoutMs,
            });
        }
        if (options.cloudProviders.includes('digitalocean')) {
            this.digitalOceanInstanceManager = new DigitalOceanInstanceManager({
                isDryRun: options.isDryRun,
                digitalOceanAPIToken: options.digitalOceanAPIToken,
                digitalOceanConfigurationFilePath: options.digitalOceanConfigurationFilePath,
            });
        }
        if (options.cloudProviders.includes('nomad')) {
            this.nomadInstanceManager = new NomadInstanceManager({
                isDryRun: options.isDryRun,
            });
        }
    }

    selectInstanceManager(cloud: string): CloudInstanceManager {
        switch (cloud) {
            case 'oracle':
                return this.oracleInstanceManager;
            case 'oraclepool':
                return this.oracleInstancePoolManager;
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
