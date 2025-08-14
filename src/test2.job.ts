import { nanoid } from "nanoid";
import { add } from ".";
import { job } from "./job";
import path from "path";
import { CosmosClient } from "@azure/cosmos";

@job("test-job-3")
export class MyJob3 {
  run() {
    const endpoint = "https://your-account.documents.azure.com";
    const key = "<database account masterkey>";
    const client = new CosmosClient({ endpoint, key });

    return 0;
  }
}
