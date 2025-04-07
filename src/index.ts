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
    /** 请求前置callback */
    beforeCallbacks =
        useCallbacks<(requestOption: RequestOption & T) => false | Promise<false> | Promise<void> | void>();

    /** 请求后置callback */
    afterCallbacks =
        useCallbacks<(requestOption: RequestOption & T, data: any | RequestError, response?: Response) => void>();

    /** 请求错误callback */
    errorCallbacks = useCallbacks<(error: RequestError<T>, response?: Response) => void>();

    constructor(public option: RequesterOption) {}

    /** 请求中队列 */
    requestList: Array<RequestQueueItem> = [];

    /** 请求接口 */
    public async request<I = any, O = any>(
        url: string,
        option?: Partial<Omit<RequestOption<I>, "url"> & T>
    ): Promise<O> {
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

        if ((await this.execBeforeEvent(requestOption)) === false) {
            return Promise.reject({
                code: ERROR_CODE_REQUEST_BREAK
            });
        }

        requestOption.data =
            (await this.option.transformReqData?.(requestOption.data, requestOption, this.option)) ??
            requestOption.data;

        if (requestOption.cache) {
            if (requestOption.cache === true) {
                requestOption.cache = {
                    id: ""
                };
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

        return new Promise((resolve, reject) => {
            let controller = new AbortController();
            let process = {
                option: requestOption,
                cancel: () => {
                    controller.abort();
                }
            };

            let timeOutTimer: number | undefined;
            let timeout = this.option.timeout;
            if (option?.timeout !== false) {
                timeout = option?.timeout;
            }

            if (timeout !== false && timeout) {
                timeOutTimer = setTimeout(() => {
                    controller.abort();
                    let error = {
                        code: ERROR_CDODE_TIME_OUT,
                        message: "请求超时，请稍后重试",
                        option: requestOption
                    };
                    this.execError(error, reject);
                }, timeout * 1000);
            }

            //决断结果
            let judgment = async (jsonData: any, response: Response) => {
                let rspData = (await this.option.transformRspData?.(jsonData, requestOption, this.option)) ?? jsonData;

                let success = (rspData: any) => {
                    if (requestOption.cache) {
                        if (requestOption.cache === true) {
                            requestOption.cache = {
                                id: ""
                            };
                        }
                        requestCache.set(`${requestOption.url}|${requestOption.cache.id}`, {
                            date: Date.now(),
                            expiresIn: requestOption.cache.expires,
                            data: rspData
                        });
                    }

                    requestOption.success?.(rspData, response);

                    for (let callback of this.afterCallbacks.callbacks) {
                        callback(requestOption, rspData);
                    }
                    resolve(rspData);
                };

                if (this.option.analyRspResult) {
                    this.option.analyRspResult(
                        rspData,
                        (data) => {
                            success(data);
                        },
                        (err) => {
                            this.execError(
                                Object.assign(err, {
                                    option: requestOption
                                }),
                                reject,
                                response
                            );
                        },
                        response
                    );
                } else {
                    success(rspData);
                }
            };

            //MOCK 扩展
            if (this.option.mock && requestOption.mock) {
                this.option
                    .mock(requestOption)
                    .then(async (data: any) => {
                        await judgment(data, {} as any);
                    })
                    .finally(() => {
                        remove(this.requestList, process);
                        if (timeOutTimer) {
                            clearTimeout(timeOutTimer);
                        }
                    });
            } else {
                let { body, headers } = transformRequestBody(requestOption.data);
                fetch(requestOption.url, {
                    body: body,
                    headers: Object.assign(headers, requestOption.headers),
                    method: requestOption.method,
                    signal: controller.signal
                })
                    //json
                    .then(async (response) => {
                        if (!response.ok) {
                            let data = await response.text();
                            this.execError(
                                {
                                    code: response.status.toString(),
                                    message: data ?? response.statusText,
                                    option: requestOption
                                },
                                reject
                            );
                            return;
                        }
                        if (requestOption.rspType === "stream") {
                            let reader = response.body?.getReader();
                            let decoder = new TextDecoder();
                            let rspStr = "";
                            if (reader) {
                                while (true) {
                                    let { done, value } = await reader.read();
                                    if (done) {
                                        await judgment(rspStr, response);
                                        break;
                                    }
                                    let chunk = decoder.decode(value);
                                    rspStr += chunk;
                                    requestOption.stream?.(chunk, rspStr);
                                }
                            } else {
                                this.execError(
                                    {
                                        code: response.status.toString(),
                                        message: "流式数据无响应",
                                        option: requestOption
                                    },
                                    reject
                                );
                            }
                        } else {
                            let jsonData = await response.json();

                            await judgment(jsonData, response);
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
                        this.execError(error, reject);
                    })
                    .finally(() => {
                        remove(this.requestList, process);
                        if (timeOutTimer) {
                            clearTimeout(timeOutTimer);
                        }
                    });
            }

            this.requestList.push(process);
        });
    }

    public cancelAllRequest() {
        for (let request of this.requestList) {
            request.cancel();
        }
    }

    private async execBeforeEvent(option: RequestOption<T>) {
        for (let callBack of this.beforeCallbacks.callbacks) {
            //@ts-ignore 串行
            if ((await callBack(option)) === false) {
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

    private execError(error: RequestError<T>, reject: Function, response?: Response) {
        //字典翻译
        if (this.option.errorCodeMessage) {
            error.message = this.option.errorCodeMessage[error.code] ?? error.message;
        }
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

        if (this.option.defaultErrorFunc) {
            this.option.defaultErrorFunc(error, response);
        }

        reject(error);
    }
}

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

/**
 * 请求处理程序配置
 */
export type RequesterOption = {
    /** 请求地址根 */
    base?: string;

    /**
     * 接口超时时间
     * 当设置为false时，不做超时处理
     * @default 10s
     */
    timeout?: number | false;

    /** 错误码-信息映射转译 */
    errorCodeMessage?: Record<string, string>;

    /** 自定义默认错误处理 */
    defaultErrorFunc?: (err: RequestError, response?: Response) => void;

    /** 自定义请求数据转换 */
    transformReqData?: (
        data: any,
        option: RequestOption & Record<string, any>,
        requesteroption: RequesterOption
    ) => any | Promise<any>;

    /** 自定义服务端返回数据转换 */
    transformRspData?: (
        data: any,
        option: RequestOption & Record<string, any>,
        requesteroption: RequesterOption
    ) => any | Promise<any>;

    /** 自定义解析rsp数据，并进行成功、失败分流 */
    analyRspResult?: (
        data: any,
        success: (data: any) => void,
        error: (err: Omit<RequestError, "option">) => void,
        response: Response
    ) => void;

    mock?: (option: RequestOption & Record<string, any>) => Promise<any>;
};

export type RequestMethod = "GET" | "POST" | "DELETE" | "PUT";

export type RequestCacheOption = {
    id: string;
    //毫秒
    expires?: number;
};

/**
 * 请求参数配置
 */
export type RequestOption<T = any> = {
    url: string;
    method: RequestMethod;
    data?: T;
    rspType?: "json" | "stream";
    timeout?: number | false;
    mock?: boolean;
    cache?: RequestCacheOption | true;
    //强制刷新缓存
    forceRefreshCache?: boolean;
    headers?: Record<string, any>;
    error?: (err: RequestError, response?: Response) => void | false;
    success?: (data: any, response?: Response) => void;
    stream?: (chunk: string, allChunk: string, response?: Response) => void;
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
