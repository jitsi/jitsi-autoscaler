import got from 'got';
import { Context } from './context';

export interface NomadJobPayload {
    [key: string]: string;
}

export interface NomadJobMeta {
    [key: string]: string;
}

interface NomadJobSummaryValues {
    Queued: number;
    Complete: number;
    Failed: number;
    Running: number;
    Starting: number;
    Lost: number;
}

interface NomadJobSummary {
    JobID: string;
    Namespace: string;
    Summary: { [key: string]: NomadJobSummaryValues };
    Children: NomadJobChildren;
    CreateIndex: number;
    ModifyIndex: number;
}

interface NomadJobChildren {
    Pending: number;
    Running: number;
    Dead: number;
}

interface NomadJobDispatchResults {
    Index: number;
    JobCreateIndex: number;
    EvalCreateIndex: number;
    EvalID: string;
    DispatchedJobID: string;
}

export interface NomadJob {
    ID: string;
    ParentID: string;
    Name: string;
    Type: string;
    Priority: string;
    Status: string;
    StatusDescription: string;
    JobSummary: NomadJobSummary;
    CreateIndex: number;
    ModifyIndex: number;
    Namespace: string;
    ParameterizedJob: boolean;
    JobModifyIndex: number;
}

export class NomadClient {
    // list nomad jobs
    async listJobs(ctx: Context, server: string, prefix: string): Promise<NomadJob[]> {
        let url = `${server}/v1/jobs`;
        if (prefix) {
            url = `${url}?prefix=${prefix}`;
        }
        ctx.logger.debug('Listing nomad jobs', { url });

        const jobs = <NomadJob[]>await got.get(url).json();
        ctx.logger.debug('Received job listing', { jobs });

        return jobs;
    }
    async dispatchJob(
        ctx: Context,
        server: string,
        job: string,
        payload: NomadJobPayload,
        meta: NomadJobMeta,
    ): Promise<NomadJobDispatchResults> {
        const url = `${server}/v1/job/${job}/dispatch`;

        const buff = Buffer.from(JSON.stringify(payload));

        const data = { Meta: meta, Payload: buff.toString('base64') };

        ctx.logger.debug('Dispatching nomad job', { url, data });

        try {
            const result = <NomadJobDispatchResults>await got.post(url, { json: data }).json();

            ctx.logger.debug('Dispatch results', { result });

            return result;
        } catch (err) {
            ctx.logger.error('Error during dispatch', { url, err });
            throw err;
        }
    }
}
