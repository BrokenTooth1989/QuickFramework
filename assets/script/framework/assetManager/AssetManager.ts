import { getSingleton } from "../base/Singleton";
import { ResourceCacheData, ResourceCacheStatus, ResourceInfo, BUNDLE_TYPE, ResourceType, BUNDLE_REMOTE } from "../base/Defines";
import { cacheManager } from "./CacheManager";
import { DataBaseTable, dataBase } from "../database/DataBase";
import { RequestPackge } from "../net/HttpClient";

/**@description 资源管理器 */
export function assetManager() {
    return getSingleton(AssetManager);
}

class RemoteLoader {

    private _logTag = `[RemoteLoader] `;
    private static _instance: RemoteLoader = null;
    public static Instance() { return this._instance || (this._instance = new RemoteLoader()); }

    private _maxConcurrentTask = 5;
    /**@description 设置下载任务的最大上限数量，目前仅对CC_JSB有效，限制downloader的任务数量  */
    public set maxConcurrentTask( value : number ){
        this._maxConcurrentTask = value;
    }
    public get maxConcurrentTask( ){
        return this._maxConcurrentTask;
    }

    /**@description 当前下载任务 */
    private _currentTaskCount = 0;

    /**@description 当前任务队列  {下载地址,存储路径}*/
    private _taskQueue : {url : string , path : string}[] = [];

    public loadImage(url: string, isNeedCache: boolean) {
        let me = this;
        return new Promise<cc.SpriteFrame>((resolve) => {
            if (url == null || url == undefined || url.length <= 0) {
                resolve(null);
                return;
            }
            let remoteUrl = parseRemoteUrl(url);
            let spCache = cacheManager().remoteCaches.getSpriteFrame(remoteUrl);
            if (spCache && spCache.data) {
                if (CC_DEBUG) cc.log(this._logTag, `从缓存精灵帧中获取:${remoteUrl.url}`);
                resolve(<cc.SpriteFrame>(spCache.data));
                return;
            }

            me._loadRemoteRes(url,cc.Texture2D , "cache_png", isNeedCache).then((data: any) => {
                let remoteUrl = parseRemoteUrl(url);
                //改变缓存类型
                let cache = cacheManager().remoteCaches.get(remoteUrl);
                if (data && cache) {
                    if (CC_DEBUG) cc.log(`${this._logTag}加载图片完成${remoteUrl.url}`);
                    cache.data = data;
                    cache.data.name = remoteUrl.url;
                    cache.data.url = remoteUrl.url;
                    let spriteFrame = cacheManager().remoteCaches.setSpriteFrame(remoteUrl, cache.data);
                    resolve(spriteFrame);
                } else {
                    if (CC_DEBUG) cc.warn(`${this._logTag}加载图片错误${remoteUrl.url}`);
                    resolve(null);
                }
            })
        });
    }

    public loadSkeleton(path: string, name: string, isNeedCache: boolean) {
        let me = this;
        return new Promise<sp.SkeletonData>((resolve) => {
            if (path && name) {
                let url = `${path}/${name}`;
                let spineAtlas = `${path}/${name}.atlas`;
                let spinePng = `${path}/${name}.png`;
                let spineJson = `${path}/${name}.json`;
                let remoteUrl = parseRemoteUrl(url);
                let cache = cacheManager().remoteCaches.get(remoteUrl);
                if (cache) {
                    if ( cache.isLoaded ){
                        resolve(<sp.SkeletonData>(cache.data));
                    }else{
                        cache.finishCb.push(resolve);
                    }
                } else {
                    cache = new ResourceCacheData();
                    cache.resourceType = ResourceType.Remote;
                    cache.assetType = sp.SkeletonData;
                    cache.bundle = BUNDLE_REMOTE;
                    cacheManager().remoteCaches.set(remoteUrl,cache);
                    me._loadRemoteRes(spinePng,cc.Texture2D, "cache_png", isNeedCache).then((texture) => {
                        if (texture) {
                            me._loadRemoteRes(spineJson,cc.JsonAsset, "cache_json", isNeedCache).then((json) => {
                                if (json) {
                                    me._loadRemoteRes(spineAtlas,cc.JsonAsset, "cache_atlas", isNeedCache).then((atlas) => {
                                        if (atlas) {
                                            //生成SkeletonData数据
                                            let asset = new sp.SkeletonData;
                                            asset.skeletonJson = json;
                                            asset.atlasText = atlas;
                                            asset.textures = [texture];
                                            let pngName = name + ".png"
                                            asset["textureNames"] = [pngName];

                                            cache.url = url;
                                            asset.name = cache.url;
                                            asset.url = cache.url;
                                            cache.data = asset;
                                            cache.isLoaded = true;
                                            resolve(<sp.SkeletonData>(cache.data));
                                            cache.doFinish(cache.data);
                                        } else {
                                            resolve(null);
                                            cache.doFinish(null);
                                            cacheManager().remoteCaches.remove(remoteUrl);
                                        }
                                    });
                                } else {
                                    resolve(null);
                                    cache.doFinish(null);
                                    cacheManager().remoteCaches.remove(remoteUrl);
                                }
                            });
                        } else {
                            resolve(null);
                            cache.doFinish(null);
                            cacheManager().remoteCaches.remove(remoteUrl);
                        }
                    })
                }
            } else {
                resolve(null);
            }
        });
    }

    /**
     * @description 加载资源
     * @param requestURL 原请求地址
     * @param storagePath 下载完成本地存储地址
     */
    private _loadLocalRes(requestURL: string, storagePath: string) {
        let me = this;
        if (CC_DEBUG) cc.log(`${this._logTag}加载本地文件:${storagePath}`);
        let urlData = parseRemoteUrl(requestURL);
        let cache = cacheManager().remoteCaches.get(urlData);
        if ( cache ){
            cc.loader.load(storagePath,(err,data) => {
                if ( cache ){
                    cache.isLoaded = true;
                    if (data) {
                        cache.data = data;
                        cache.doJsbFinish(data);
                        if ( CC_DEBUG ) cc.log(`${this._logTag}加载本地资源完成:${storagePath} => ${requestURL}`);
                    }
                    else {
                        if (CC_DEBUG) cc.warn(`${this._logTag}加载本地资源异常:${storagePath}`);
                        cache.doJsbFinish(null);
                    }
                    //把再加载过程里，双加载同一资源的回调都回调回去
                    cache.doFinish(data);
                }
            });
        }else{
            cc.error(`找不到本地缓存 requestURL : ${requestURL} storagePath : ${storagePath}`);
        }
    }

    private _loadRemoteRes(url: string,type : typeof cc.Asset , databaseTable: DataBaseTable, isNeedCache: boolean) {
        return new Promise<any>((resolve) => {
            let urlData = parseRemoteUrl(url);
            let cache = cacheManager().remoteCaches.get(urlData);
            if (cache) {
                //有缓存,查看是否已经加载
                if (cache.isLoaded) {
                    //如果已经加载完成
                    resolve(cache.data);
                } else {
                    //正在加载中
                    cache.finishCb.push(resolve);
                }
            } else {
                //没有缓存存在,生成加载缓存
                cache = new ResourceCacheData();
                cache.resourceType = ResourceType.Remote;
                cache.assetType = type;
                cacheManager().remoteCaches.set(urlData, cache);
                if (CC_JSB) {
                    let path = makeRemoteUrl(urlData);
                    let fullPath = `${jsb.fileUtils.getWritablePath()}${path}`;
                    if (CC_DEBUG) cc.log(`${this._logTag}${urlData.url}下载的资源将存入本地${fullPath}`);
                    //先缓存回调，加载完成后再回调
                    cache.jsbFinishCb = resolve;
                    cache.jsbStoragePath = fullPath;

                    //先再本地查找有没有下载好的资源，如果有，直接创建
                    if (jsb.fileUtils.isFileExist(fullPath)) {
                        if (isNeedCache) {
                            if (CC_DEBUG) cc.log(`${this._logTag}本地已经存在${urlData.url} 本地路径为:${fullPath} ,使用本地缓存资源创建`);
                            this._loadLocalRes(urlData.url, fullPath);
                        } else {
                            if (CC_DEBUG) cc.log(this._logTag, `${urlData.url}资源不需要缓存,重新下载`);
                            jsb.fileUtils.removeFile(fullPath);
                            this.pushTask(urlData.url,fullPath);
                        }
                    } else {


                        let tempPath = `${jsb.fileUtils.getWritablePath()}${urlData.path}`;
                        if (jsb.fileUtils.isDirectoryExist(tempPath)) {
                            if (CC_DEBUG) cc.log(`已经存在文件夹：${tempPath}`);
                        } else {
                            if (CC_DEBUG) cc.log(`创建文件夹:${tempPath}`);
                            jsb.fileUtils.createDirectory(tempPath);
                        }
                        this.pushTask(urlData.url,fullPath);
                    }
                } else {
                    if (isNeedCache) {
                        //网页h5方式加载
                        if (dataBase().isSupport()) {
                            dataBase().get(databaseTable, urlData.url).then((data) => {
                                if (data) {
                                    this._loadH5DatabaseData(cache, databaseTable, resolve, data);
                                }
                                else {
                                    this._loadH5RemoteData(cache, databaseTable, urlData, resolve, isNeedCache, true);
                                }
                            });
                        } else {
                            this._loadH5RemoteData(cache, databaseTable, urlData, resolve, isNeedCache, false);
                        }
                    } else {
                        //不需要做本地缓存处理
                        this._loadH5RemoteData(cache, databaseTable, urlData, resolve, isNeedCache, false);
                    }
                }
            }
        });
    }

    private _loadH5RemoteData(cache: ResourceCacheData, databaseTable: DataBaseTable, urlData: RemoteUrl, resolve, isNeedCache: boolean, isSupportDatabase: boolean) {
        let packge = new RequestPackge;
        packge.data.url = urlData.url;
        packge.data.isAutoAttachCurrentTime = !isNeedCache;
        if (databaseTable == "cache_png") {
            packge.data.responseType = "blob";
        }
        packge.send((netData) => {
            //存入数据库
            if (isNeedCache && isSupportDatabase) {
                dataBase().put(databaseTable, { key: packge.data.url, data: netData });
            }
            this._loadH5DatabaseData(cache, databaseTable, resolve, netData);
        }, (err) => {
            resolve(null);
            if (CC_DEBUG) cc.warn(this._logTag, `加载网络资源异常:${urlData.url}`);
            cache.doFinish(null);
            cacheManager().remoteCaches.remove(urlData);
        });
    }

    private _loadH5DatabaseData(cache: ResourceCacheData, databaseTable: DataBaseTable, resolve, data) {
        if (databaseTable == "cache_png") {
            //创建图片
            let imgUrl = URL.createObjectURL(data);
            let image = new Image();
            image.src = imgUrl;

            //等图片加载完成后，才创建图片贴图，不然没办法正常显示 
            image.addEventListener("load", (ev) => {
                let texture = new cc.Texture2D();
                texture.initWithElement(image);
                cache.isLoaded = true;
                cache.data = texture;
                resolve(cache.data);
                cache.doFinish(cache.data);
                URL.revokeObjectURL(imgUrl);
            })
        } else if (databaseTable == "cache_json") {
            let json = JSON.parse(data);
            cache.isLoaded = true;
            cache.data = json;
            resolve(cache.data);
            cache.doFinish(cache.data);
        }
        else if (databaseTable == "cache_atlas") {
            cache.isLoaded = true;
            cache.data = data;
            resolve(cache.data);
            cache.doFinish(cache.data);
        }
    }

    /**@description 由主游戏控制器驱动，在下载远程资源时，设置一个上限下载任务数据，以免同一时间任务数量过大 */
    update(){
        if ( CC_JSB ){
            while ( this._currentTaskCount < this.maxConcurrentTask && this._taskQueue.length > 0 ){
                this._currentTaskCount ++;
                let value = this._taskQueue.shift();
                if ( CC_DEBUG ) cc.log(`创建下载任务:${value.url}`);
                let packge = new RequestPackge;
                let me = this;
                packge.data.url = value.url;
                packge.data.responseType = "arraybuffer";
                packge.send((netData) => {
                    //写本地
                    let data = new Uint8Array(netData);
                    let isSuccess = false;
                    if ( CC_JSB ){
                        isSuccess =  jsb.fileUtils.writeDataToFile( data , value.path);
                    }
                    if ( isSuccess ){
                        me.onLoadSuccess({requestURL : value.url,storagePath : value.path});
                    }else{
                        me.onLoadError({requestURL : value.url,storagePath : value.path},0,0,`写入本地${value.path}失败`);
                    }

                }, (err) => {
                    cc.error(`下载错误 : ${value.url}`);
                    me.onLoadError({requestURL : value.url,storagePath : value.path},err.type,0,err.reason);
                });
            }
        }
    }

    /**@description 加载成功 */
    private onLoadSuccess(task) {
        if (CC_DEBUG) cc.log(`${this._logTag}加载资源完成 : ${task.requestURL}`);

        //下载完成，减少当前任务数量
        this._currentTaskCount--;
        this._loadLocalRes(task.requestURL, task.storagePath);
    }

    private onLoadError(task, errorCode, errorCodeInternal, errorStr) {
        if (CC_DEBUG) cc.error(`${this._logTag}task url : ${task.requestURL} , errorCode : ${errorCode} , internal : ${errorCodeInternal} reason : ${errorStr}`);
        //下载错误，减少当前任务数量 
        this._currentTaskCount--;
        let remoteUrl = parseRemoteUrl(task.requestURL);
        let cache = cacheManager().remoteCaches.get(remoteUrl);
        cache.isLoaded = true;
        cache.data = null;
        if (CC_DEBUG) cc.warn(`${this._logTag}下载远程资源异常:${task.requestURL}`);
        cache.doJsbFinish(null);
        //把再加载过程里，双加载同一资源的回调都回调回去
        cache.doFinish(null);
        cacheManager().remoteCaches.remove(remoteUrl);
    }

    private pushTask( url : string , path : string ){

        for ( let i = 0 ; i < this._taskQueue.length ; i++ ){
            if ( this._taskQueue[i].url == url ){
                if ( CC_DEBUG ) cc.log(`已经存在下载任务:${url}`);
                return;
            }
        }
        if ( CC_DEBUG ) cc.log(`当前任务数:${this._currentTaskCount} / ${this.maxConcurrentTask} 添加下载任务:${url}`);
        this._taskQueue.push({url: url,path : path});
    }
}


class AssetManager {
    private logTag = `[AssetManager]: `;
    private static _instance: AssetManager = null;
    public static Instance() {
        return this._instance || (this._instance = new AssetManager());
    }

    private _remote = new RemoteLoader();
    public get remote(){ return this._remote;}
    /**
     * @description 获取Bundle
     * @param bundle Bundle名|Bundle
     */
    public getBundle(bundle: BUNDLE_TYPE ) {
        if ( bundle ){
            if ( typeof bundle == "string" ){
                return cc.assetManager.getBundle(bundle);
            }
            return bundle;
        }
        return null;
    }

    public load(
        bundle: BUNDLE_TYPE,
        path: string,
        type: typeof cc.Asset,
        onProgress: (finish: number, total: number, item: cc.AssetManager.RequestItem) => void,
        onComplete: (data:ResourceCacheData) => void): void {
            let cache = cacheManager().get(bundle,path);
            if ( cache ){
                //存在缓存信息
                if ( cache.isLoaded ){
                    //已经加载完成
                    if (CC_DEBUG && cache.status == ResourceCacheStatus.WAITTING_FOR_RELEASE ){
                        cc.warn(this.logTag, `资源:${path} 等待释放，但资源已经加载完成，此时有人又重新加载，不进行释放处理`);
                    }
                    //加载完成
                    onComplete(cache);
                }else{
                    if (CC_DEBUG && cache.status == ResourceCacheStatus.WAITTING_FOR_RELEASE ){
                        cc.warn(this.logTag, `资源:${path}等待释放，但资源处理加载过程中，此时有人又重新加载，不进行释放处理`);
                    }
                    cache.finishCb.push(onComplete);
                }
                //重新复位资源状态
                cache.status = ResourceCacheStatus.NONE;
            }else{
                //无缓存信息
                cache = new ResourceCacheData();
                cache.url = path;
                cache.assetType = type;
                cache.bundle = bundle;
                cacheManager().set(bundle,path,cache);
                cc.time(`加载资源 : ${cache.url}`);
                let _bundle = this.getBundle(bundle);
                if (!_bundle ){
                    //如果bundle不存在
                    let error = new Error(`${this.logTag} ${bundle} 没有加载，请先加载`);
                    this._onLoadComplete(cache,onComplete,error,null);
                    return;
                }
                let res = _bundle.get(path,type);
                if ( res ){
                    this._onLoadComplete(cache,onComplete,null,res);
                }else{
                    if ( onProgress ){
                        _bundle.load(path,type,onProgress,this._onLoadComplete.bind(this,cache,onComplete));
                    }else{
                        _bundle.load(path,type,this._onLoadComplete.bind(this,cache,onComplete));
                    }
                }
            }
    }

    private _onLoadComplete( cache : ResourceCacheData , completeCallback: (data: ResourceCacheData) => void,err:Error,data:cc.Asset){
        cache.isLoaded = true;
        //添加引用关系
        let tempCache = cache;
        if (err) {
            cc.error(`${this.logTag}加载资源失败:${cache.url} 原因:${err.message ? err.message : "未知"}`);
            cache.data = null;
            tempCache.data = null;
            cacheManager().remove(cache.bundle,cache.url);
            completeCallback(cache);
        }
        else {
            if (CC_DEBUG) cc.log(`${this.logTag}加载资源成功:${cache.url}`);
            cache.data = data;
            tempCache.data = data;
            completeCallback(cache);
        }

        //加载过程，有不同地方调用过来加载同一个资源的地方，都回调回去
        cache.doFinish(tempCache);
        cache.doGet(tempCache.data);

        if (cache.status == ResourceCacheStatus.WAITTING_FOR_RELEASE) {
            if (CC_DEBUG) cc.warn(this.logTag, `资源:${cache.url}加载完成，但缓存状态为等待销毁，销毁资源`);
            if (cache.data) {
                cache.status = ResourceCacheStatus.NONE;
                let info = new ResourceInfo;
                info.url = cache.url;
                info.type = cache.assetType;
                info.data = cache.data;
                info.bundle = cache.bundle;
                this.releaseAsset(info);
            }
        }

        cc.timeEnd(`加载资源 : ${cache.url}`);
    }

    public releaseAsset( info : ResourceInfo ){
        if ( info.bundle ){
            cacheManager().remove(info.bundle,info.url);
            let bundle = this.getBundle(info.bundle);
            if ( bundle ){
                bundle.release(info.url,info.type);
            }
        }
    }

}