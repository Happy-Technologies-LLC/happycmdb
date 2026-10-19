import { Queue, Worker, Job } from 'bullmq';
export declare class QueueManager {
    private queues;
    private workers;
    getQueue(name: string): Queue;
    registerWorker(queueName: string, processor: (job: Job, token?: string) => Promise<any>, options?: {
        concurrency?: number;
    }): Worker;
    closeAll(): Promise<void>;
}
export declare const queueManager: QueueManager;
export declare function closeQueueManagerConnection(): Promise<void>;
export { QUEUE_NAMES } from '@cmdb/common';
//# sourceMappingURL=queue-manager.d.ts.map