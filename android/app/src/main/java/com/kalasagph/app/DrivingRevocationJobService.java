package com.kalasagph.app;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class DrivingRevocationJobService extends JobService {
    private static final int JOB_ID = 0x4B414C53;
    private static final long INITIAL_RETRY_DELAY_MS = 15_000L;
    private static final long BACKOFF_MS = 30_000L;

    private ExecutorService executor;
    private Handler mainHandler;

    static boolean schedule(Context context) {
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler == null) return false;
        JobInfo job = new JobInfo.Builder(
            JOB_ID,
            new ComponentName(context, DrivingRevocationJobService.class)
        )
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setMinimumLatency(INITIAL_RETRY_DELAY_MS)
            .setBackoffCriteria(BACKOFF_MS, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
            .setPersisted(true)
            .build();
        return scheduler.schedule(job) == JobScheduler.RESULT_SUCCESS;
    }

    static void cancel(Context context) {
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler != null) scheduler.cancel(JOB_ID);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        executor = Executors.newSingleThreadExecutor();
        mainHandler = new Handler(Looper.getMainLooper());
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        if (executor == null || executor.isShutdown()) {
            executor = Executors.newSingleThreadExecutor();
        }
        DrivingCredentialStore.Credentials credentials = DrivingCredentialStore.load(this);
        if (credentials == null || !DrivingCredentialStore.isStopRequested(this)) {
            jobFinished(params, false);
            return false;
        }

        executor.execute(() -> {
            DrivingRevocationClient.Result result = DrivingRevocationClient.revoke(credentials);
            mainHandler.post(() -> {
                if (result == DrivingRevocationClient.Result.RETRYABLE) {
                    // JobScheduler applies bounded exponential backoff and keeps
                    // this persisted job across process death/device reboot.
                    jobFinished(params, true);
                    return;
                }
                DrivingCredentialStore.clearIfSession(this, credentials.sessionId);
                DrivingLocationService.clearRuntimeStatus(this, null);
                jobFinished(params, false);
            });
        });
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        if (executor != null) executor.shutdownNow();
        return DrivingCredentialStore.isStopRequested(this);
    }

    @Override
    public void onDestroy() {
        if (executor != null) executor.shutdownNow();
        super.onDestroy();
    }
}
