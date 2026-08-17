import { useCallbacks, remove, isEmptyObject } from "@joker.front/shared";

export const ERROR_CODE_REQUEST_BREAK = "ERROR_CODE_REQUEST_BREAK";
export const ERROR_CODE_REQUEST_ABORT = "ERROR_CODE_REQUEST_ABORT";
export const ERROR_CODE_REQUEST_DEFAULT = "ERROR_CODE_REQUEST";
export const ERROR_CDODE_TIME_OUT = "ERROR_CDODE_TIME_OUT";

const hasProtocolRegex = /^(https?:\/\/|localhost)/;
let requestCache = new Map<
    string,
    {
        date?: number;
        expiresIn?: number;
        data: any;
    }
>();

/** 请求处理程序 */
export class Requester<T = {}> {
    beforeCallbacks = useCallbacks<(requestOption: RequestOption & T) => false | void>();
    afterCallbacks =
        useCallbacks<(requestOption: RequestOption & T, data: any | RequestError, response?: Response) => void>();
    errorCallbacks = useCallbacks<(error: RequestError<T>, response?: Response) => void>();

    constructor(public option: RequesterOption) {}

    requestList: Array<RequestQueueItem> = [];

    public async request<I = any, O = any>(
        url: string,
        option?: Partial<Omit<RequestOption<I>, "url"> & T>
    ): Promise<O> {
        // ---------- 仅执行一次的前置处理 ----------
        let requestOption: RequestOption & T = Object.assign(
            {
                url,
                method: "POST" as RequestMethod,
                timeout: 10,
                rspType: "json"
            },
            option
        ) as any;

        if (hasProtocolRegex.test(requestOption.url) === false) {
            requestOption.url = (this.option.base || "") + requestOption.url;
        }

        if (this.execBeforeEvent(requestOption) === false) {
            return Promise.reject({
                code: ERROR_CODE_REQUEST_BREAK
            });
        }

        requestOption.data =
            (await this.option.transformReqData?.(requestOption.data, requestOption, this.option)) ??
            requestOption.data;

        // 缓存命中直接返回，不进入重试
        if (requestOption.cache) {
            if (requestOption.cache === true) {
                requestOption.cache = { id: "" };
            }
            let requestCacheId = `${requestOption.url}|${requestOption.cache?.id}`;
            if (requestOption.forceRefreshCache) {
                this.deleteCache(requestCacheId);
            } else {
                let cacheData = this.getCache(requestCacheId);
                if (cacheData !== undefined) {
                    requestOption.success?.(cacheData);
                    for (let callback of this.afterCallbacks.callbacks) {
                        callback(requestOption, cacheData);
                    }
                    return Promise.resolve(cacheData);
                }
            }
        }

        // ---------- 重试配置 ----------
        const maxRetries = option?.retry ?? this.option.maxRetry ?? 0;
        const retryDelay = option?.retryDelay ?? this.option.retryDelay ?? 0;
        let lastError: any;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const result = await this._execute(requestOption);
                // 成功：更新缓存（若有）
                this.setCache(requestOption, result);
                // 成功回调
                requestOption.success?.(result);
                for (let callback of this.afterCallbacks.callbacks) {
                    callback(requestOption, result);
                }
                return result;
            } catch (err) {
                lastError = err;
                // 判断是否可重试，若不可重试或已达最大次数则跳出
                if (!this.shouldRetry(err) || attempt === maxRetries) {
                    break;
                }
                // 重试前等待间隔，避开瞬时网络抖动
                if (retryDelay > 0) {
                    await new Promise((r) => setTimeout(r, retryDelay));
                }
            }
        }

        // ---------- 最终失败处理 ----------
        return new Promise((resolve, reject) => {
            this.execError(lastError, reject);
        });
    }

    /** 单次请求执行（无任何用户回调） */
    private _execute(requestOption: RequestOption & T): Promise<any> {
        return new Promise((resolve, reject) => {
            let controller = new AbortController();
            let process: RequestQueueItem = {
                option: requestOption,
                cancel: () => controller.abort()
            };

            let timeOutTimer: number | undefined;
            let timeout = this.option.timeout;
            if (requestOption.timeout !== false) {
                timeout = requestOption.timeout;
            }

            if (timeout !== false && timeout) {
                timeOutTimer = setTimeout(() => {
                    controller.abort();
                    reject({
                        code: ERROR_CDODE_TIME_OUT,
                        message: "请求超时，请稍后重试",
                        option: requestOption
                    });
                }, timeout * 1000);
            }

            // 响应解析（不含回调）
            const handleResponse = async (jsonData: any, response: Response) => {
                let rspData = (await this.option.transformRspData?.(jsonData, requestOption, this.option)) ?? jsonData;

                // 若存在自定义解析器，则用其分流
                if (this.option.analyRspResult) {
                    new Promise<void>((res, rej) => {
                        this.option.analyRspResult!(
                            rspData,
                            (data) => {
                                resolve(data);
                                res();
                            },
                            (err) => {
                                rej(Object.assign(err, { option: requestOption }));
                            },
                            response
                        );
                    }).catch(reject);
                } else {
                    resolve(rspData);
                }
            };

            // 正常 fetch
            let fetchOptions: any = {};
            if (requestOption.method === "GET") {
                const params = new URLSearchParams(requestOption.data);
                requestOption.url += `?${params.toString()}`;
                fetchOptions = {
                    headers: Object.assign({}, requestOption.headers),
                    method: requestOption.method,
                    signal: controller.signal
                };
            } else {
                let { body, headers } = transformRequestBody(requestOption.data);
                fetchOptions = {
                    body,
                    headers: Object.assign(headers, requestOption.headers),
                    method: requestOption.method,
                    signal: controller.signal
                };
            }

            this.requestList.push(process);

            fetch(requestOption.url, fetchOptions)
                .then(async (response) => {
                    if (!response.ok) {
                        let data = await response.text();
                        reject({
                            code: response.status.toString(),
                            message: data ?? response.statusText,
                            option: requestOption
                        });
                        return;
                    }

                    if (requestOption.rspType === "stream") {
                        let reader = response.body?.getReader();
                        let decoder = new TextDecoder();
                        if (reader) {
                            while (true) {
                                let { done, value } = await reader.read();
                                let chunk = decoder.decode(value);
                                const sseBlocks = chunk.split("\n\n").filter(Boolean);
                                sseBlocks.map((n) => {
                                    const dataMatch = n.match(/^data:\s*(.*)/);
                                    if (dataMatch) {
                                        // 流式回调允许在重试时重新触发（符合预期）
                                        requestOption.stream?.(dataMatch[1] || "");
                                    }
                                });
                                if (done) {
                                    // 流式完成，直接 resolve（不触发成功回调）
                                    resolve(undefined);
                                    break;
                                }
                            }
                        } else {
                            reject({
                                code: response.status.toString(),
                                message: "流式数据无响应",
                                option: requestOption
                            });
                        }
                    } else {
                        let jsonData = await response.json();
                        await handleResponse(jsonData, response);
                    }
                })
                .catch((e) => {
                    let error = {
                        code: e.name === "AbortError" ? ERROR_CODE_REQUEST_ABORT : ERROR_CODE_REQUEST_DEFAULT,
                        message: e.name === "AbortError" ? undefined : e.message || "请求资源异常",
                        option: requestOption,
                        e
                    };
                    if (e.name !== "AbortError") {
                        console.error(e);
                    }
                    reject(error);
                })
                .finally(() => {
                    remove(this.requestList, process);
                    if (timeOutTimer) clearTimeout(timeOutTimer);
                });
        });
    }

    public cancelAllRequest(filter?: (option: RequestOption) => boolean) {
        for (let request of this.requestList) {
            if (filter) {
                if (!filter(request.option)) continue;
            }
            request.cancel();
        }
    }

    public cancelRequest(id: string) {
        for (let request of this.requestList) {
            if (request.option.id === id) request.cancel();
        }
    }

    private execBeforeEvent(option: RequestOption & T) {
        for (let callBack of this.beforeCallbacks.callbacks) {
            if (callBack(option) === false) {
                return false;
            }
        }
        return true;
    }

    private deleteCache(cacheId: string) {
        requestCache.delete(cacheId);
    }

    private getCache(cacheId: string) {
        let cache = requestCache.get(cacheId);
        if (cache) {
            if (cache.date && cache.expiresIn) {
                if (Date.now() - cache.date > cache.expiresIn) {
                    requestCache.delete(cacheId);
                    return;
                }
            }
            return cache.data;
        }
    }

    private setCache(requestOption: RequestOption & T, data: any) {
        if (!requestOption.cache) return;
        let cacheOption = requestOption.cache === true ? { id: "" } : requestOption.cache;
        requestCache.set(`${requestOption.url}|${cacheOption.id}`, {
            date: Date.now(),
            expiresIn: cacheOption.expires,
            data
        });
    }

    /** 判断错误是否可重试（仅当确定服务器未受理请求时） */
    private shouldRetry(error: any): boolean {
        const code = error?.code;
        if (!code) return false;
        // 用户取消不重试
        if (code === ERROR_CODE_REQUEST_ABORT) return false;
        // 网络错误：请求未到达服务器，可安全重试
        if (code === ERROR_CODE_REQUEST_DEFAULT) return true;
        // 超时：可能是本地网络问题导致请求未到达服务器，重试
        if (code === ERROR_CDODE_TIME_OUT) return true;
        // 5xx/429：服务器已受理请求，不重试（避免重复副作用）
        return false;
    }

    private execError(error: RequestError<T>, reject: Function, response?: Response) {
        if (this.option.errorCodeMessage) {
            error.message = this.option.errorCodeMessage[error.code] ?? error.message;
        }
        try {
            for (let callback of this.afterCallbacks.callbacks) {
                callback(error.option, error, response);
            }
            for (let callback of this.errorCallbacks.callbacks) {
                callback(error, response);
            }
            if (error.option.error) {
                if (error.option.error(error, response) === false) {
                    reject(error);
                    return;
                }
            }
        } catch (e) {
            console.error(e);
        }
        if (this.option.defaultErrorFunc) {
            this.option.defaultErrorFunc(error, response);
        }
        reject(error);
    }
}

// ---------- 类型定义 ----------
export type RequestQueueItem = {
    cancel: Function;
    option: RequestOption;
};

export type RequestError<T = any> = {
    code: string;
    message: string;
    data?: any;
    option: RequestOption & T;
    e?: Error;
};

export type RequesterOption = {
    base?: string;
    timeout?: number | false;
    errorCodeMessage?: Record<string, string>;
    defaultErrorFunc?: (err: RequestError, response?: Response) => void;
    transformReqData?: (
        data: any,
        option: RequestOption & Record<string, any>,
        requesteroption: RequesterOption
    ) => any | Promise<any>;
    transformRspData?: (
        data: any,
        option: RequestOption & Record<string, any>,
        requesteroption: RequesterOption
    ) => any | Promise<any>;
    analyRspResult?: (
        data: any,
        success: (data: any) => void,
        error: (err: Omit<RequestError, "option">) => void,
        response: Response
    ) => void;
    mock?: (option: RequestOption & Record<string, any>) => Promise<any>;
    /** 全局最大重试次数（默认 0） */
    maxRetry?: number;
    /** 全局重试间隔（毫秒，默认 0 表示立即重试） */
    retryDelay?: number;
};

export type RequestMethod = "GET" | "POST" | "DELETE" | "PUT";

export type RequestCacheOption = {
    id: string;
    expires?: number;
};

export type RequestOption<T = any> = {
    id?: string;
    url: string;
    method: RequestMethod;
    data?: T;
    rspType?: "json" | "stream";
    timeout?: number | false;
    cache?: RequestCacheOption | true;
    forceRefreshCache?: boolean;
    headers?: Record<string, any>;
    error?: (err: RequestError, response?: Response) => void | false;
    success?: (data: any, response?: Response) => void;
    stream?: (chunk: string, response?: Response) => void;
    /** 请求级重试次数（覆盖全局） */
    retry?: number;
    /** 请求级重试间隔（毫秒，覆盖全局） */
    retryDelay?: number;
};

function transformRequestBody(data: any) {
    let files: Record<string, File | FileList | Array<File>> = {};
    if (data && typeof data === "object") {
        for (let name in data) {
            let item = data[name];
            if (item) {
                if (
                    item instanceof File ||
                    item instanceof FileList ||
                    (Array.isArray(item) && item.length && item[0] instanceof File)
                ) {
                    files[name] = item;
                }
            }
        }
    }

    for (let file in files) {
        delete data[file];
    }

    if (files && isEmptyObject(files) === false) {
        let formData = new FormData();

        for (let name in files) {
            let item = files[name];

            if (item instanceof FileList || Array.isArray(item)) {
                for (let file of item) {
                    formData.append(name, file);
                }
            } else {
                formData.append(name, item);
            }
        }

        formData.append("jsonData", JSON.stringify(data));

        return {
            body: formData,
            headers: {}
        };
    }

    return {
        body: JSON.stringify(data),
        headers: {
            "Content-Type": "application/json"
        }
    };
}
