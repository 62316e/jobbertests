import { nanoid } from "nanoid";
import { add } from ".";
import { job } from "./job";
import path from "path";

@job("test-job-3")
export class MyJob3 {
  run() {
    return 0;
  }
}
