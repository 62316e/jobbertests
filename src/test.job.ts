import { nanoid } from 'nanoid';
import { add } from '.';
import { job } from './job';
import path from 'path';

@job("test-job")
export class MyJob {
    run() {
        console.log('Running MyJob...', path.basename(__filename));
        const id = nanoid();
        console.log('Generated ID:', id);
        const sum = add(10, 10);
        console.log('Sum:', sum);
        return { id, sum };
    }
}

@job("test-job-2")
export class MyJob2 {
    run() {
        const sum = add(10, 10);
        console.log('Sum:', sum);
        return { sum };
    }
}
